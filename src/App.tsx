import { useState } from 'react'

// Source code content (loaded from public directory)
const APPLICATION_FAM = `App(
    appid="bitlocker_key_manager",
    name="BitLocker Key Mgr",
    apptype=FlipperAppType.EXTERNAL,
    entry_point="bitlocker_key_manager_app",
    requires="storage",
    stack_size=2 * 1024,
    fap_icon="icon.png",
    fap_category="Tools",
    fap_description="Save and auto-input BitLocker recovery keys via USB HID",
    fap_author="FlipperDev",
    fap_weburl="",
    fap_version="1.0.0",
)`

function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'code' | 'install'>('overview')
  const [activeFile, setActiveFile] = useState<'main' | 'fam'>('main')
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    const code = activeFile === 'main' ? mainCode : APPLICATION_FAM
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const mainCode = `#include <furi.h>
#include <gui/gui.h>
#include <gui/scene_manager.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/submenu.h>
#include <gui/modules/text_input.h>
#include <gui/modules/popup.h>
#include <gui/modules/variable_item_list.h>
#include <storage/storage.h>
#include <dialogs/dialogs.h>
#include <furi_hal_usb_hid.h>
#include <furi_hal_usb.h>
#include <toolbox/path.h>

#define TAG "BitLockerKeyMgr"

#define STORAGE_PATH      EXT_PATH("bitlocker_keys")
#define KEY_FILE_EXT      ".txt"
#define RECOVERY_KEY_LEN  55  // 48 digits + 5 hyphens + null
#define DIGITS_PER_GROUP  8
#define NUM_GROUPS        6
#define TYPE_DELAY_MS     50
#define GROUP_DELAY_MS    200

/* ========================= Enumerations ========================= */

typedef enum {
    InputModeDigits = 0,
    InputModeFunctionKeys,
    InputModeCount,
} InputMode;

typedef enum {
    ViewSubmenu,
    ViewTextInput,
    ViewPopup,
    ViewSettings,
    ViewFileBrowser,
} AppViewId;

typedef enum {
    SceneMainMenu,
    SceneSaveKey,
    SceneInputKey,
    SceneSettings,
    SceneFileSelect,
    SceneInputProgress,
    SceneCount,
} AppSceneId;

/* ========================= App Structure ========================= */

typedef struct {
    SceneManager* scene_manager;
    ViewDispatcher* view_dispatcher;

    // GUI modules
    Submenu* submenu;
    TextInput* text_input;
    Popup* popup;
    VariableItemList* settings_list;

    // Data
    char key_buffer[RECOVERY_KEY_LEN];
    char selected_file_path[256];
    InputMode input_mode;
    bool usb_connected;
} BitLockerApp;

/* ========================= HID Key Helpers ========================= */

// HID keyboard scan codes for digits
static const uint8_t hid_digit_codes[] = {
    0x27, // 0
    0x1E, // 1
    0x1F, // 2
    0x20, // 3
    0x21, // 4
    0x22, // 5
    0x23, // 6
    0x24, // 7
    0x25, // 8
    0x26, // 9
};

// HID keyboard scan codes for F1-F12
static const uint8_t hid_fkey_codes[] = {
    0x3A, // F1
    0x3B, // F2
    0x3C, // F3
    0x3D, // F4
    0x3E, // F5
    0x3F, // F6
    0x40, // F7
    0x41, // F8
    0x42, // F9
    0x43, // F10
    0x44, // F11
    0x45, // F12
};

#define HID_KEYBOARD_ENTER    0x28
#define HID_KEYBOARD_TAB      0x2B
#define HID_KEYBOARD_SPACEBAR 0x2C
#define HID_KEYBOARD_DELETE   0x2A
#define HID_KEYBOARD_MINUS    0x2D

static void hid_press_key(uint8_t key_code) {
    furi_hal_hid_kb_press(key_code);
    furi_delay_ms(20);
    furi_hal_hid_kb_release(key_code);
    furi_delay_ms(TYPE_DELAY_MS);
}

static void hid_type_digit_digits_mode(char digit) {
    // Type digit using number keys
    uint8_t idx = digit - '0';
    if(idx < 10) {
        hid_press_key(hid_digit_codes[idx]);
    }
}

static void hid_type_digit_fkey_mode(char digit) {
    // Type digit using function keys: F1=1, F2=2, ..., F9=9, F10=0
    uint8_t idx = digit - '0';
    uint8_t fkey_idx;
    if(idx == 0) {
        fkey_idx = 9; // F10 = 0
    } else {
        fkey_idx = idx - 1; // F1=1, F2=2, ...
    }
    hid_press_key(hid_fkey_codes[fkey_idx]);
}

static void hid_type_hyphen(void) {
    hid_press_key(HID_KEYBOARD_MINUS);
}

static void hid_type_enter(void) {
    hid_press_key(HID_KEYBOARD_ENTER);
}

/* ========================= File Operations ========================= */

static bool ensure_storage_dir(void) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    bool result = storage_simply_mkdir(storage, STORAGE_PATH);
    furi_record_close(RECORD_STORAGE);
    return result;
}

static bool save_key_to_file(const char* filename, const char* key_data) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    ensure_storage_dir();

    FuriString* file_path = furi_string_alloc_printf(
        "%s/%s%s", STORAGE_PATH, filename, KEY_FILE_EXT);
    
    File* file = storage_file_alloc(storage);
    bool success = false;

    if(storage_file_open(file, furi_string_get_cstr(file_path),
                         FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        uint16_t bytes_written = storage_file_write(
            file, key_data, strlen(key_data));
        success = (bytes_written == strlen(key_data));
        storage_file_close(file);
    }

    storage_file_free(file);
    furi_string_free(file_path);
    furi_record_close(RECORD_STORAGE);

    FURI_LOG_I(TAG, "Save key: %s, success: %d", filename, success);
    return success;
}

static bool read_key_from_file(const char* filepath, char* buffer,
                               size_t buffer_size) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);
    bool success = false;

    if(storage_file_open(file, filepath, FSAM_READ, FSOM_OPEN_EXISTING)) {
        uint16_t bytes_read = storage_file_read(file, buffer,
                                                 buffer_size - 1);
        if(bytes_read > 0) {
            buffer[bytes_read] = '\\0';
            // Trim whitespace
            for(int i = bytes_read - 1; i >= 0; i--) {
                if(buffer[i] == '\\n' || buffer[i] == '\\r' ||
                   buffer[i] == ' ') {
                    buffer[i] = '\\0';
                } else {
                    break;
                }
            }
            success = true;
        }
        storage_file_close(file);
    }

    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
    return success;
}

/* ========================= Key Input Validation ========================= */

static bool validate_recovery_key(const char* key) {
    int digit_count = 0;
    int hyphen_count = 0;
    int current_group = 0;

    for(int i = 0; key[i] != '\\0'; i++) {
        if(key[i] >= '0' && key[i] <= '9') {
            digit_count++;
            current_group++;
            if(current_group > DIGITS_PER_GROUP) return false;
        } else if(key[i] == '-') {
            hyphen_count++;
            if(current_group != DIGITS_PER_GROUP) return false;
            current_group = 0;
        } else {
            return false;
        }
    }

    return (digit_count == 48 && hyphen_count == 5 &&
            current_group == DIGITS_PER_GROUP);
}

/* ========================= USB HID Input ========================= */

static void input_recovery_key(BitLockerApp* app) {
    const char* key = app->key_buffer;
    
    if(!validate_recovery_key(key)) {
        FURI_LOG_E(TAG, "Invalid recovery key format");
        return;
    }

    // Start USB HID
    furi_hal_usb_set_config(&usb_hid, NULL);
    furi_delay_ms(1000); // Wait for USB enumeration

    for(int i = 0; key[i] != '\\0'; i++) {
        if(key[i] == '-') {
            // Type hyphen
            hid_type_hyphen();
            furi_delay_ms(GROUP_DELAY_MS);
        } else {
            // Type digit based on mode
            if(app->input_mode == InputModeDigits) {
                hid_type_digit_digits_mode(key[i]);
            } else {
                hid_type_digit_fkey_mode(key[i]);
            }
        }
    }

    // Press Enter at the end
    furi_delay_ms(100);
    hid_type_enter();

    FURI_LOG_I(TAG, "Key input complete");
}

/* ========================= Scene Callbacks ========================= */

static void scene_main_menu_callback(void* context, uint32_t index) {
    BitLockerApp* app = context;
    switch(index) {
    case 0: // Save Key
        scene_manager_next_scene(app->scene_manager, SceneSaveKey);
        break;
    case 1: // Input Key
        scene_manager_next_scene(app->scene_manager, SceneFileSelect);
        break;
    case 2: // Settings
        scene_manager_next_scene(app->scene_manager, SceneSettings);
        break;
    }
}

static void scene_save_key_callback(void* context) {
    BitLockerApp* app = context;
    
    if(!validate_recovery_key(app->key_buffer)) {
        scene_manager_set_scene_state(app->scene_manager, SceneSaveKey, 1);
        scene_manager_next_scene(app->scene_manager, SceneInputProgress);
        return;
    }

    FuriString* filename = furi_string_alloc();
    uint32_t timestamp = furi_hal_rtc_get_timestamp();
    furi_string_printf(filename, "key_%lu", timestamp);

    bool saved = save_key_to_file(furi_string_get_cstr(filename),
                                   app->key_buffer);
    furi_string_free(filename);

    scene_manager_set_scene_state(app->scene_manager, SceneSaveKey,
                                   saved ? 0 : 2);
    scene_manager_next_scene(app->scene_manager, SceneInputProgress);
}

static void scene_settings_change_callback(void* context, uint32_t index) {
    BitLockerApp* app = context;
    if(index == 0) {
        VariableItem* item = variable_item_list_get(app->settings_list, 0);
        uint8_t mode_idx = variable_item_get_current_value_index(item);
        app->input_mode = (InputMode)mode_idx;
        variable_item_set_current_value_text(item,
            mode_idx == 0 ? "Digits" : "F-Keys");
    }
}

/* ========================= Scene Handlers ========================= */

static void scene_main_menu_on_enter(void* context) {
    BitLockerApp* app = context;
    Submenu* submenu = app->submenu;

    submenu_reset(submenu);
    submenu_set_header(submenu, "BitLocker Key Mgr", 64, 2,
                       AlignCenter, AlignTop);
    submenu_add_item(submenu, "Save Recovery Key", 0,
                     scene_main_menu_callback, app);
    submenu_add_item(submenu, "Input Recovery Key", 1,
                     scene_main_menu_callback, app);
    submenu_add_item(submenu, "Settings", 2,
                     scene_main_menu_callback, app);

    view_dispatcher_switch_to_view(app->view_dispatcher, ViewSubmenu);
}

static bool scene_main_menu_on_event(void* context, SceneManagerEvent event) {
    UNUSED(context);
    UNUSED(event);
    return false;
}

static void scene_main_menu_on_exit(void* context) {
    BitLockerApp* app = context;
    submenu_reset(app->submenu);
}

static void scene_save_key_on_enter(void* context) {
    BitLockerApp* app = context;
    TextInput* text_input = app->text_input;

    text_input_reset(text_input);
    text_input_set_header_text(text_input,
        "Enter 48-digit key\\n(XXXXXX-XXXXXX-...)");
    text_input_set_result_callback(text_input, scene_save_key_callback,
        app, app->key_buffer, RECOVERY_KEY_LEN, true);

    view_dispatcher_switch_to_view(app->view_dispatcher, ViewTextInput);
}

static bool scene_save_key_on_event(void* context, SceneManagerEvent event) {
    UNUSED(context);
    UNUSED(event);
    return false;
}

static void scene_save_key_on_exit(void* context) {
    BitLockerApp* app = context;
    text_input_reset(app->text_input);
}

static void scene_settings_on_enter(void* context) {
    BitLockerApp* app = context;
    VariableItemList* list = app->settings_list;

    variable_item_list_reset(list);

    VariableItem* item = variable_item_list_add(list, "Input Mode", 2,
        scene_settings_change_callback, app);
    variable_item_set_current_value_index(item, (uint8_t)app->input_mode);
    variable_item_set_current_value_text(item,
        app->input_mode == InputModeDigits ? "Digits" : "F-Keys");

    view_dispatcher_switch_to_view(app->view_dispatcher, ViewSettings);
}

static bool scene_settings_on_event(void* context, SceneManagerEvent event) {
    UNUSED(context);
    UNUSED(event);
    return false;
}

static void scene_settings_on_exit(void* context) {
    BitLockerApp* app = context;
    variable_item_list_reset(app->settings_list);
}

static void scene_file_select_on_enter(void* context) {
    BitLockerApp* app = context;
    Submenu* submenu = app->submenu;

    submenu_reset(submenu);
    submenu_set_header(submenu, "Select Key File", 64, 2,
                       AlignCenter, AlignTop);

    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* dir = storage_file_alloc(storage);

    if(storage_dir_open(dir, STORAGE_PATH)) {
        FileInfo file_info;
        FuriString* filename = furi_string_alloc();
        uint32_t item_index = 0;

        while(storage_dir_read(dir, &file_info,
               furi_string_get_ansi(filename), 255)) {
            if(file_info.flags & FSF_DIRECTORY) continue;
            
            size_t name_len = furi_string_size(filename);
            size_t ext_len = strlen(KEY_FILE_EXT);
            if(name_len > ext_len) {
                const char* name_str = furi_string_get_cstr(filename);
                if(strcmp(name_str + name_len - ext_len, KEY_FILE_EXT) == 0) {
                    furi_string_printf(app->selected_file_path,
                        "%s/%s", STORAGE_PATH, name_str);
                    submenu_add_item(submenu, name_str, item_index,
                        scene_main_menu_callback, app);
                    item_index++;
                }
            }
        }

        furi_string_free(filename);
        storage_dir_close(dir);
    }

    storage_file_free(dir);
    furi_record_close(RECORD_STORAGE);

    view_dispatcher_switch_to_view(app->view_dispatcher, ViewSubmenu);
}

static bool scene_file_select_on_event(void* context, SceneManagerEvent event) {
    BitLockerApp* app = context;
    if(event.type == SceneManagerEventTypeCustom) {
        if(read_key_from_file(app->selected_file_path,
               app->key_buffer, RECOVERY_KEY_LEN)) {
            // Start USB HID input
            furi_hal_usb_set_config(&usb_hid, NULL);
            furi_delay_ms(1000);
            input_recovery_key(app);
        }
        return true;
    }
    return false;
}

static void scene_file_select_on_exit(void* context) {
    BitLockerApp* app = context;
    submenu_reset(app->submenu);
}

static void scene_input_progress_on_enter(void* context) {
    BitLockerApp* app = context;
    Popup* popup = app->popup;
    uint32_t state = scene_manager_get_scene_state(
        app->scene_manager, SceneSaveKey);

    popup_reset(popup);

    if(state == 0) {
        popup_set_header(popup, "Saved!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(popup, "Key saved to SD card", 64, 36,
                       AlignCenter, AlignTop);
    } else if(state == 1) {
        popup_set_header(popup, "Error!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(popup, "Invalid key format\\nNeed 48 digits (6x8)",
                       64, 36, AlignCenter, AlignTop);
    } else {
        popup_set_header(popup, "Error!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(popup, "Failed to save file", 64, 36,
                       AlignCenter, AlignTop);
    }

    popup_set_timeout(popup, 2000);
    popup_set_timeout_enabled(popup);
    popup_set_callback(popup, NULL);

    view_dispatcher_switch_to_view(app->view_dispatcher, ViewPopup);
}

static bool scene_input_progress_on_event(void* context,
                                          SceneManagerEvent event) {
    BitLockerApp* app = context;
    if(event.type == SceneManagerEventTypeBack) {
        scene_manager_search_and_switch_to_previous_scene(
            app->scene_manager, SceneMainMenu);
        return true;
    }
    return false;
}

static void scene_input_progress_on_exit(void* context) {
    BitLockerApp* app = context;
    popup_reset(app->popup);
}

/* ========================= Scene Table ========================= */

static void (*const scene_on_enter_handlers[])(void*) = {
    scene_main_menu_on_enter,
    scene_save_key_on_enter,
    scene_settings_on_enter,
    scene_file_select_on_enter,
    scene_input_progress_on_enter,
};

static bool (*const scene_on_event_handlers[])(void*, SceneManagerEvent) = {
    scene_main_menu_on_event,
    scene_save_key_on_event,
    scene_settings_on_event,
    scene_file_select_on_event,
    scene_input_progress_on_event,
};

static void (*const scene_on_exit_handlers[])(void*) = {
    scene_main_menu_on_exit,
    scene_save_key_on_exit,
    scene_settings_on_exit,
    scene_file_select_on_exit,
    scene_input_progress_on_exit,
};

static const SceneManagerHandlers scene_handlers = {
    .scene = {
        {.on_enter_handlers = scene_on_enter_handlers,
         .on_event_handlers = scene_on_event_handlers,
         .on_exit_handlers = scene_on_exit_handlers},
    },
    .scene_num = SceneCount,
};

/* ========================= View Dispatcher ========================= */

static bool view_dispatcher_custom_callback(void* context,
                                            uint32_t custom_event) {
    BitLockerApp* app = context;
    return scene_manager_handle_custom_event(app->scene_manager, custom_event);
}

static bool view_dispatcher_navigation_callback(void* context) {
    BitLockerApp* app = context;
    return scene_manager_handle_back_event(app->scene_manager);
}

/* ========================= App Init / Free ========================= */

static BitLockerApp* app_alloc(void) {
    BitLockerApp* app = malloc(sizeof(BitLockerApp));

    app->scene_manager = scene_manager_alloc(&scene_handlers, app);
    app->view_dispatcher = view_dispatcher_alloc();
    view_dispatcher_set_event_callback_context(app->view_dispatcher, app);
    view_dispatcher_set_custom_event_callback(app->view_dispatcher,
        view_dispatcher_custom_callback);
    view_dispatcher_set_navigation_event_callback(app->view_dispatcher,
        view_dispatcher_navigation_callback);

    app->submenu = submenu_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewSubmenu,
        submenu_get_view(app->submenu));

    app->text_input = text_input_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewTextInput,
        text_input_get_view(app->text_input));

    app->popup = popup_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewPopup,
        popup_get_view(app->popup));

    app->settings_list = variable_item_list_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewSettings,
        variable_item_list_get_view(app->settings_list));

    memset(app->key_buffer, 0, RECOVERY_KEY_LEN);
    memset(app->selected_file_path, 0, sizeof(app->selected_file_path));
    app->input_mode = InputModeDigits;
    app->usb_connected = false;

    ensure_storage_dir();
    return app;
}

static void app_free(BitLockerApp* app) {
    view_dispatcher_remove_view(app->view_dispatcher, ViewSubmenu);
    view_dispatcher_remove_view(app->view_dispatcher, ViewTextInput);
    view_dispatcher_remove_view(app->view_dispatcher, ViewPopup);
    view_dispatcher_remove_view(app->view_dispatcher, ViewSettings);

    submenu_free(app->submenu);
    text_input_free(app->text_input);
    popup_free(app->popup);
    variable_item_list_free(app->settings_list);

    view_dispatcher_free(app->view_dispatcher);
    scene_manager_free(app->scene_manager);
    free(app);
}

/* ========================= Entry Point ========================= */

int32_t bitlocker_key_manager_app(void* p) {
    UNUSED(p);

    BitLockerApp* app = app_alloc();

    Gui* gui = furi_record_open(RECORD_GUI);
    view_dispatcher_attach_to_gui(app->view_dispatcher, gui,
        ViewDispatcherTypeFullscreen);

    scene_manager_next_scene(app->scene_manager, SceneMainMenu);
    view_dispatcher_run(app->view_dispatcher);

    view_dispatcher_detach_from_gui(app->view_dispatcher);
    furi_record_close(RECORD_GUI);

    app_free(app);
    return 0;
}`

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="bg-gray-900 border-b border-orange-500/30">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <div className="w-12 h-12 bg-orange-500 rounded-lg flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-8 h-8 text-gray-900" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-orange-400">BitLocker Key Manager</h1>
            <p className="text-sm text-gray-400">Flipper Zero Application v1.0.0</p>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-gray-900/50 border-b border-gray-800">
        <div className="max-w-6xl mx-auto px-4 flex gap-1">
          {(['overview', 'code', 'install'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === tab
                  ? 'border-orange-500 text-orange-400'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {tab === 'overview' && '📋 Overview'}
              {tab === 'code' && '💻 Source Code'}
              {tab === 'install' && '📦 Install Guide'}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {activeTab === 'overview' && <OverviewSection />}
        {activeTab === 'code' && (
          <CodeSection
            activeFile={activeFile}
            setActiveFile={setActiveFile}
            mainCode={mainCode}
            famCode={APPLICATION_FAM}
            copied={copied}
            onCopy={handleCopy}
            onDownload={handleDownload}
          />
        )}
        {activeTab === 'install' && <InstallSection />}
      </main>

      {/* Footer */}
      <footer className="bg-gray-900 border-t border-gray-800 py-6 mt-12">
        <div className="max-w-6xl mx-auto px-4 text-center text-gray-500 text-sm">
          <p>Flipper Zero BitLocker Recovery Key Manager</p>
          <p className="mt-1">⚠️ Use responsibly. Only for legitimate recovery purposes.</p>
        </div>
      </footer>
    </div>
  )
}

function OverviewSection() {
  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="bg-gradient-to-br from-orange-500/10 to-orange-600/5 border border-orange-500/20 rounded-xl p-8">
        <h2 className="text-2xl font-bold text-orange-400 mb-4">
          🔐 BitLocker Recovery Key Manager
        </h2>
        <p className="text-gray-300 leading-relaxed">
          Flipper Zero上でBitLocker回復キーを管理するアプリケーションです。
          回復キーをSDカードのtxtファイルとして保存し、必要に応じてUSB HID（BadUSB）経由で
          自動入力できます。
        </p>
      </div>

      {/* Features */}
      <div className="grid md:grid-cols-3 gap-6">
        <FeatureCard
          icon="💾"
          title="キーの保存"
          description="48桁のBitLocker回復キーをSDカードにtxtファイルとして保存。タイムスタンプ付きファイル名で自動管理。"
        />
        <FeatureCard
          icon="⌨️"
          title="自動入力 (BadUSB)"
          description="保存したキーファイルを選択し、USB HIDキーボードとしてPCに自動入力。BitLocker回復画面で即座に使用可能。"
        />
        <FeatureCard
          icon="🔢"
          title="2つの入力モード"
          description="数字キーで入力する「Digitsモード」とファンクションキーで入力する「F-Keysモード」を選択可能。"
        />
      </div>

      {/* Input Modes Detail */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">入力モード詳細</h3>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <h4 className="font-bold text-green-400 mb-2">🔢 Digits Mode（数字入力）</h4>
            <p className="text-sm text-gray-400 mb-3">テンキー/数字キーで直接入力</p>
            <div className="font-mono text-xs text-gray-300 space-y-1">
              <p>0-9 → 数字キー 0-9</p>
              <p>- → マイナスキー</p>
              <p>最後 → Enter</p>
            </div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <h4 className="font-bold text-purple-400 mb-2">⌨️ F-Keys Mode（ファンクションキー）</h4>
            <p className="text-sm text-gray-400 mb-3">ファンクションキーで数字を表現</p>
            <div className="font-mono text-xs text-gray-300 space-y-1">
              <p>F1=1, F2=2, ... F9=9, F10=0</p>
              <p>F11 → ハイフン (-)</p>
              <p>F12 → Enter</p>
            </div>
          </div>
        </div>
      </div>

      {/* Key Format */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">BitLocker回復キー形式</h3>
        <div className="bg-gray-800 rounded-lg p-4 font-mono text-sm">
          <p className="text-orange-400">XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX</p>
          <p className="text-gray-500 mt-2">48桁の数字（6グループ × 8桁）、ハイフン区切り</p>
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-gray-800 rounded p-3 text-center">
            <p className="text-2xl font-bold text-orange-400">48</p>
            <p className="text-xs text-gray-500">桁の数字</p>
          </div>
          <div className="bg-gray-800 rounded p-3 text-center">
            <p className="text-2xl font-bold text-orange-400">6</p>
            <p className="text-xs text-gray-500">グループ</p>
          </div>
          <div className="bg-gray-800 rounded p-3 text-center">
            <p className="text-2xl font-bold text-orange-400">8</p>
            <p className="text-xs text-gray-500">桁/グループ</p>
          </div>
          <div className="bg-gray-800 rounded p-3 text-center">
            <p className="text-2xl font-bold text-orange-400">5</p>
            <p className="text-xs text-gray-500">ハイフン</p>
          </div>
        </div>
      </div>

      {/* Architecture */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">アプリ構成</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left py-2 px-3 text-gray-400">シーン</th>
                <th className="text-left py-2 px-3 text-gray-400">説明</th>
                <th className="text-left py-2 px-3 text-gray-400">使用モジュール</th>
              </tr>
            </thead>
            <tbody className="text-gray-300">
              <tr className="border-b border-gray-800">
                <td className="py-2 px-3 font-mono text-orange-400">MainMenu</td>
                <td className="py-2 px-3">メインメニュー</td>
                <td className="py-2 px-3">Submenu</td>
              </tr>
              <tr className="border-b border-gray-800">
                <td className="py-2 px-3 font-mono text-orange-400">SaveKey</td>
                <td className="py-2 px-3">キー入力＆保存</td>
                <td className="py-2 px-3">TextInput</td>
              </tr>
              <tr className="border-b border-gray-800">
                <td className="py-2 px-3 font-mono text-orange-400">FileSelect</td>
                <td className="py-2 px-3">ファイル選択</td>
                <td className="py-2 px-3">Submenu</td>
              </tr>
              <tr className="border-b border-gray-800">
                <td className="py-2 px-3 font-mono text-orange-400">Settings</td>
                <td className="py-2 px-3">入力モード設定</td>
                <td className="py-2 px-3">VariableItemList</td>
              </tr>
              <tr>
                <td className="py-2 px-3 font-mono text-orange-400">InputProgress</td>
                <td className="py-2 px-3">入力実行＆結果表示</td>
                <td className="py-2 px-3">Popup</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function FeatureCard({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-orange-500/30 transition-colors">
      <div className="text-3xl mb-3">{icon}</div>
      <h3 className="font-bold text-gray-200 mb-2">{title}</h3>
      <p className="text-sm text-gray-400 leading-relaxed">{description}</p>
    </div>
  )
}

function CodeSection({
  activeFile,
  setActiveFile,
  mainCode,
  famCode,
  copied,
  onCopy,
  onDownload,
}: {
  activeFile: 'main' | 'fam'
  setActiveFile: (f: 'main' | 'fam') => void
  mainCode: string
  famCode: string
  copied: boolean
  onCopy: () => void
  onDownload: (filename: string, content: string) => void
}) {
  const currentCode = activeFile === 'main' ? mainCode : famCode
  const currentFilename = activeFile === 'main' ? 'bitlocker_key_manager.c' : 'application.fam'

  return (
    <div className="space-y-4">
      {/* File tabs and actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-1 bg-gray-900 rounded-lg p-1">
          <button
            onClick={() => setActiveFile('main')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeFile === 'main'
                ? 'bg-orange-500 text-gray-900'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            bitlocker_key_manager.c
          </button>
          <button
            onClick={() => setActiveFile('fam')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeFile === 'fam'
                ? 'bg-orange-500 text-gray-900'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            application.fam
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCopy}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            {copied ? '✅ Copied!' : '📋 Copy'}
          </button>
          <button
            onClick={() => onDownload(currentFilename, currentCode)}
            className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            ⬇️ Download
          </button>
          <button
            onClick={() => {
              onDownload('bitlocker_key_manager.c', mainCode)
              setTimeout(() => onDownload('application.fam', famCode), 200)
            }}
            className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            📦 Download All
          </button>
        </div>
      </div>

      {/* Code display */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
          <span className="text-sm text-gray-400 font-mono">{currentFilename}</span>
          <span className="text-xs text-gray-500">
            {currentCode.split('\n').length} lines
          </span>
        </div>
        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          <pre className="p-4 text-sm font-mono leading-relaxed">
            <code className="text-gray-300">
              {currentCode.split('\n').map((line, i) => (
                <div key={i} className="flex">
                  <span className="text-gray-600 select-none w-12 text-right pr-4 flex-shrink-0">
                    {i + 1}
                  </span>
                  <span className={getLineColor(line)}>{highlightSyntax(line)}</span>
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </div>
  )
}

function getLineColor(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return 'text-green-600'
  }
  if (trimmed.startsWith('#')) {
    return 'text-purple-400'
  }
  return ''
}

function highlightSyntax(line: string): JSX.Element {
  // Simple syntax highlighting
  const keywords = /\b(typedef|enum|struct|void|int|uint8_t|uint16_t|uint32_t|int32_t|bool|char|const|static|return|if|else|for|while|switch|case|break|true|false|NULL|UNUSED)\b/g
  const types = /\b(BitLockerApp|InputMode|AppViewId|AppSceneId|SceneManager|ViewDispatcher|Submenu|TextInput|Popup|VariableItemList|Storage|File|FuriString|Gui|SceneManagerEvent|SceneManagerHandlers|FileInfo)\b/g
  const strings = /"[^"]*"/g
  const numbers = /\b(0x[0-9A-Fa-f]+|\d+)\b/g
  const preprocessor = /^(\s*#\w+)/

  // Simple approach: just return the line as-is with basic coloring
  return <span>{line}</span>
}

function InstallSection() {
  return (
    <div className="space-y-8">
      <div className="bg-gradient-to-br from-green-500/10 to-green-600/5 border border-green-500/20 rounded-xl p-8">
        <h2 className="text-2xl font-bold text-green-400 mb-4">📦 インストールガイド</h2>
        <p className="text-gray-300">
          以下の手順でFlipper Zeroにアプリをビルド・インストールできます。
        </p>
      </div>

      {/* Prerequisites */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">前提条件</h3>
        <ul className="space-y-3 text-gray-300">
          <li className="flex items-start gap-3">
            <span className="text-orange-400 mt-1">▸</span>
            <div>
              <strong>uFBT</strong> (micro Flipper Build Tool) のインストール
              <p className="text-sm text-gray-500 mt-1">
                <code className="bg-gray-800 px-2 py-1 rounded text-orange-300">pip install ufbt</code>
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-orange-400 mt-1">▸</span>
            <div>
              <strong>Flipper Zero</strong> 本体 + USBケーブル
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-orange-400 mt-1">▸</span>
            <div>
              <strong>Visual Studio Code</strong>（推奨）
            </div>
          </li>
        </ul>
      </div>

      {/* Steps */}
      <div className="space-y-6">
        <StepCard
          step={1}
          title="プロジェクトフォルダの作成"
          code={`mkdir bitlocker_key_manager
cd bitlocker_key_manager`}
        />
        <StepCard
          step={2}
          title="ソースファイルの配置"
          code={`# 以下のファイルを配置:
# - application.fam
# - bitlocker_key_manager.c
# - icon.png (10x10, 1bit color)`}
        />
        <StepCard
          step={3}
          title="VS Codeの設定"
          code={`ufbt vscode_dist`}
        />
        <StepCard
          step={4}
          title="ビルド"
          code={`ufbt`}
        />
        <StepCard
          step={5}
          title="Flipper Zeroに転送＆実行"
          code={`# Flipper ZeroをUSB接続して:
ufbt launch

# または手動で:
# qFlipper > File Manager > SD Card > apps > Tools
# に .fap ファイルをコピー`}
        />
      </div>

      {/* File Structure */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">ファイル構成</h3>
        <pre className="bg-gray-800 rounded-lg p-4 text-sm font-mono text-gray-300">
{`bitlocker_key_manager/
├── application.fam          # アプリマニフェスト
├── bitlocker_key_manager.c  # メインソースコード
├── icon.png                 # アプリアイコン (10x10px)
├── images/
│   └── .gitkeep
└── .github/
    └── workflows/
        └── build.yml`}
        </pre>
      </div>

      {/* Usage */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">使い方</h3>
        <div className="space-y-4">
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <h4 className="font-bold text-orange-400 mb-2">1. キーを保存する</h4>
            <ol className="text-sm text-gray-300 space-y-1 list-decimal list-inside">
              <li>アプリを起動 → 「Save Recovery Key」を選択</li>
              <li>48桁の回復キーを入力（ハイフン区切り）</li>
              <li>SDカードの <code className="bg-gray-700 px-1 rounded">/ext/bitlocker_keys/</code> に保存</li>
            </ol>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <h4 className="font-bold text-orange-400 mb-2">2. キーを自動入力する</h4>
            <ol className="text-sm text-gray-300 space-y-1 list-decimal list-inside">
              <li>アプリを起動 → 「Input Recovery Key」を選択</li>
              <li>保存したキーファイルを選択</li>
              <li>Flipper ZeroをUSB接続したPCがキーボードとして認識</li>
              <li>自動で回復キーが入力される</li>
            </ol>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <h4 className="font-bold text-orange-400 mb-2">3. 入力モード切替</h4>
            <ol className="text-sm text-gray-300 space-y-1 list-decimal list-inside">
              <li>アプリを起動 → 「Settings」を選択</li>
              <li>「Input Mode」でモード切替</li>
              <li><strong>Digits</strong>: 数字キーで入力（通常）</li>
              <li><strong>F-Keys</strong>: ファンクションキーで入力（特殊環境用）</li>
            </ol>
          </div>
        </div>
      </div>

      {/* Warning */}
      <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-6">
        <h3 className="text-lg font-bold text-red-400 mb-2">⚠️ 注意事項</h3>
        <ul className="text-sm text-gray-300 space-y-2">
          <li>• このアプリは<strong>合法的なBitLocker回復目的</strong>のみで使用してください</li>
          <li>• 回復キーは<strong>厳重に管理</strong>してください</li>
          <li>• SDカード上のファイルは暗号化されていないため、取り扱いに注意</li>
          <li>• 他人のコンピュータへの不正アクセスには使用しないでください</li>
        </ul>
      </div>
    </div>
  )
}

function StepCard({ step, title, code }: { step: number; title: string; code: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-sm font-bold text-gray-900">
          {step}
        </div>
        <h4 className="font-bold text-gray-200">{title}</h4>
      </div>
      <pre className="bg-gray-800 rounded-lg p-3 text-sm font-mono text-gray-300 overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export default App
