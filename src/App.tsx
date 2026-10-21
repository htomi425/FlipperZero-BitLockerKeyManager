import { useState } from 'react'

// ========================= Source Code Constants =========================

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
    fap_version="0.0.0",
)`

const BUILD_YML = `name: "FAP: Build for multiple SDK sources"

on:
  push:
    branches:
      - main
      - master
  pull_request:
  schedule:
    # Daily build at 01:00 UTC
    - cron: "0 1 * * *"
  workflow_dispatch:

env:
  SHORT_SHA: \${{ github.sha }}

jobs:
  ufbt-build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - name: dev channel
            sdk-channel: dev
          - name: release channel
            sdk-channel: release
    name: 'ufbt: Build for \${{ matrix.name }}'
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set version from SHA
        run: |
          SHORT_SHA=$(echo "\${{ github.sha }}" | cut -c1-7)
          echo "SHORT_SHA=\${SHORT_SHA}" >> \$GITHUB_ENV
          sed -i "s/fap_version=\\"[^\\"]*\\"/fap_version=\\"\${SHORT_SHA}\\"/" application.fam
          echo "Updated fap_version to: \${SHORT_SHA}"
          grep fap_version application.fam

      - name: Build with ufbt
        uses: flipperdevices/flipperzero-ufbt-action@v0.1
        id: build-app
        with:
          sdk-channel: \${{ matrix.sdk-channel }}

      - name: Upload app artifacts
        uses: actions/upload-artifact@v4
        with:
          name: bitlocker_key_manager-\${{ env.SHORT_SHA }}-\${{ matrix.sdk-channel }}
          path: \${{ steps.build-app.outputs.fap-artifacts }}
          if-no-files-found: error
          retention-days: 30

  ufbt-lint:
    runs-on: ubuntu-latest
    name: 'ufbt: Lint sources'
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup ufbt
        uses: flipperdevices/flipperzero-ufbt-action@v0.1
        id: setup-ufbt
        with:
          task: setup
          sdk-channel: dev

      - name: Lint sources
        uses: flipperdevices/flipperzero-ufbt-action@v0.1
        with:
          skip-setup: true
          task: lint

  release:
    if: github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master')
    needs: [ufbt-build, ufbt-lint]
    runs-on: ubuntu-latest
    name: 'Create Release'
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set short SHA
        run: |
          SHORT_SHA=$(echo "\${{ github.sha }}" | cut -c1-7)
          echo "SHORT_SHA=\${SHORT_SHA}" >> \$GITHUB_ENV
          echo "Release version: \${SHORT_SHA}"

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts/

      - name: List artifacts
        run: |
          echo "Downloaded artifacts:"
          find artifacts/ -type f -name "*.fap" -o -name "*.fal" | sort

      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: \${{ env.SHORT_SHA }}
          name: "Build \${{ env.SHORT_SHA }}"
          body: |
            ## BitLocker Key Manager — Build \${{ env.SHORT_SHA }}

            ### Build Info
            | Field | Value |
            |-------|-------|
            | **Commit** | \`\${{ github.sha }}\` |
            | **Short SHA** | \`\${{ env.SHORT_SHA }}\` |
            | **Branch** | \`\${{ github.ref_name }}\` |
            | **Triggered by** | \`\${{ github.actor }}\` |
            | **Date** | \${{ github.event.head_commit.timestamp }} |

            ### Installation
            1. Download the .fap file matching your firmware version
            2. Copy to Flipper Zero SD card: /ext/apps/Tools/
            3. Launch from Apps → Tools → BitLocker Key Mgr

            ### Files
            - *-dev.fap — Built for dev/unleashed firmware
            - *-release.fap — Built for official release firmware
          files: artifacts/**/*.fap
          draft: false
          prerelease: false
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}`

const MAIN_C_CODE = `#include <furi.h>
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
#define RECOVERY_KEY_LEN  55
#define DIGITS_PER_GROUP  8
#define NUM_GROUPS        6
#define TYPE_DELAY_MS     50
#define GROUP_DELAY_MS    200

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

typedef struct {
    SceneManager* scene_manager;
    ViewDispatcher* view_dispatcher;
    Submenu* submenu;
    TextInput* text_input;
    Popup* popup;
    VariableItemList* settings_list;
    char key_buffer[RECOVERY_KEY_LEN];
    char selected_file_path[256];
    InputMode input_mode;
    bool usb_connected;
} BitLockerApp;

static const uint8_t hid_digit_codes[] = {
    0x27, 0x1E, 0x1F, 0x20, 0x21,
    0x22, 0x23, 0x24, 0x25, 0x26,
};

static const uint8_t hid_fkey_codes[] = {
    0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F,
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45,
};

#define HID_KEYBOARD_ENTER  0x28
#define HID_KEYBOARD_MINUS  0x2D

static void hid_press_key(uint8_t key_code) {
    furi_hal_hid_kb_press(key_code);
    furi_delay_ms(20);
    furi_hal_hid_kb_release(key_code);
    furi_delay_ms(TYPE_DELAY_MS);
}

static void hid_type_digit_digits_mode(char digit) {
    uint8_t idx = digit - '0';
    if(idx < 10) hid_press_key(hid_digit_codes[idx]);
}

static void hid_type_digit_fkey_mode(char digit) {
    uint8_t idx = digit - '0';
    uint8_t fkey_idx = (idx == 0) ? 9 : idx - 1;
    hid_press_key(hid_fkey_codes[fkey_idx]);
}

static void hid_type_hyphen(void) {
    hid_press_key(HID_KEYBOARD_MINUS);
}

static void hid_type_enter(void) {
    hid_press_key(HID_KEYBOARD_ENTER);
}

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
        uint16_t written = storage_file_write(file, key_data, strlen(key_data));
        success = (written == strlen(key_data));
        storage_file_close(file);
    }
    storage_file_free(file);
    furi_string_free(file_path);
    furi_record_close(RECORD_STORAGE);
    return success;
}

static bool read_key_from_file(const char* filepath, char* buffer, size_t buf_size) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);
    bool success = false;
    if(storage_file_open(file, filepath, FSAM_READ, FSOM_OPEN_EXISTING)) {
        uint16_t bytes_read = storage_file_read(file, buffer, buf_size - 1);
        if(bytes_read > 0) {
            buffer[bytes_read] = '\\0';
            for(int i = bytes_read - 1; i >= 0; i--) {
                if(buffer[i] == '\\n' || buffer[i] == '\\r' || buffer[i] == ' ')
                    buffer[i] = '\\0';
                else break;
            }
            success = true;
        }
        storage_file_close(file);
    }
    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
    return success;
}

static bool validate_recovery_key(const char* key) {
    int digits = 0, hyphens = 0, group = 0;
    for(int i = 0; key[i] != '\\0'; i++) {
        if(key[i] >= '0' && key[i] <= '9') {
            digits++; group++;
            if(group > DIGITS_PER_GROUP) return false;
        } else if(key[i] == '-') {
            hyphens++;
            if(group != DIGITS_PER_GROUP) return false;
            group = 0;
        } else return false;
    }
    return (digits == 48 && hyphens == 5 && group == DIGITS_PER_GROUP);
}

static void input_recovery_key(BitLockerApp* app) {
    const char* key = app->key_buffer;
    if(!validate_recovery_key(key)) return;
    furi_hal_usb_set_config(&usb_hid, NULL);
    furi_delay_ms(1000);
    for(int i = 0; key[i] != '\\0'; i++) {
        if(key[i] == '-') {
            hid_type_hyphen();
            furi_delay_ms(GROUP_DELAY_MS);
        } else {
            if(app->input_mode == InputModeDigits)
                hid_type_digit_digits_mode(key[i]);
            else
                hid_type_digit_fkey_mode(key[i]);
        }
    }
    furi_delay_ms(100);
    hid_type_enter();
}

static void scene_main_menu_callback(void* context, uint32_t index) {
    BitLockerApp* app = context;
    switch(index) {
    case 0: scene_manager_next_scene(app->scene_manager, SceneSaveKey); break;
    case 1: scene_manager_next_scene(app->scene_manager, SceneFileSelect); break;
    case 2: scene_manager_next_scene(app->scene_manager, SceneSettings); break;
    }
}

static void scene_save_key_callback(void* context) {
    BitLockerApp* app = context;
    if(!validate_recovery_key(app->key_buffer)) {
        scene_manager_set_scene_state(app->scene_manager, SceneSaveKey, 1);
        scene_manager_next_scene(app->scene_manager, SceneInputProgress);
        return;
    }
    FuriString* fn = furi_string_alloc();
    furi_string_printf(fn, "key_%lu", furi_hal_rtc_get_timestamp());
    bool saved = save_key_to_file(furi_string_get_cstr(fn), app->key_buffer);
    furi_string_free(fn);
    scene_manager_set_scene_state(app->scene_manager, SceneSaveKey, saved ? 0 : 2);
    scene_manager_next_scene(app->scene_manager, SceneInputProgress);
}

static void scene_settings_change_callback(void* context, uint32_t index) {
    BitLockerApp* app = context;
    if(index == 0) {
        VariableItem* item = variable_item_list_get(app->settings_list, 0);
        uint8_t mode_idx = variable_item_get_current_value_index(item);
        app->input_mode = (InputMode)mode_idx;
        variable_item_set_current_value_text(item, mode_idx == 0 ? "Digits" : "F-Keys");
    }
}

static void scene_main_menu_on_enter(void* context) {
    BitLockerApp* app = context;
    submenu_reset(app->submenu);
    submenu_set_header(app->submenu, "BitLocker Key Mgr", 64, 2, AlignCenter, AlignTop);
    submenu_add_item(app->submenu, "Save Recovery Key", 0, scene_main_menu_callback, app);
    submenu_add_item(app->submenu, "Input Recovery Key", 1, scene_main_menu_callback, app);
    submenu_add_item(app->submenu, "Settings", 2, scene_main_menu_callback, app);
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewSubmenu);
}

static bool scene_main_menu_on_event(void* c, SceneManagerEvent e) { UNUSED(c); UNUSED(e); return false; }
static void scene_main_menu_on_exit(void* context) { submenu_reset(((BitLockerApp*)context)->submenu); }

static void scene_save_key_on_enter(void* context) {
    BitLockerApp* app = context;
    text_input_reset(app->text_input);
    text_input_set_header_text(app->text_input, "Enter 48-digit key\\n(XXXXXX-XXXXXX-...)");
    text_input_set_result_callback(app->text_input, scene_save_key_callback,
        app, app->key_buffer, RECOVERY_KEY_LEN, true);
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewTextInput);
}

static bool scene_save_key_on_event(void* c, SceneManagerEvent e) { UNUSED(c); UNUSED(e); return false; }
static void scene_save_key_on_exit(void* context) { text_input_reset(((BitLockerApp*)context)->text_input); }

static void scene_settings_on_enter(void* context) {
    BitLockerApp* app = context;
    variable_item_list_reset(app->settings_list);
    VariableItem* item = variable_item_list_add(app->settings_list,
        "Input Mode", 2, scene_settings_change_callback, app);
    variable_item_set_current_value_index(item, (uint8_t)app->input_mode);
    variable_item_set_current_value_text(item, app->input_mode == InputModeDigits ? "Digits" : "F-Keys");
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewSettings);
}

static bool scene_settings_on_event(void* c, SceneManagerEvent e) { UNUSED(c); UNUSED(e); return false; }
static void scene_settings_on_exit(void* context) { variable_item_list_reset(((BitLockerApp*)context)->settings_list); }

static void scene_file_select_on_enter(void* context) {
    BitLockerApp* app = context;
    submenu_reset(app->submenu);
    submenu_set_header(app->submenu, "Select Key File", 64, 2, AlignCenter, AlignTop);
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* dir = storage_file_alloc(storage);
    if(storage_dir_open(dir, STORAGE_PATH)) {
        FileInfo fi;
        FuriString* fn = furi_string_alloc();
        uint32_t idx = 0;
        while(storage_dir_read(dir, &fi, furi_string_get_ansi(fn), 255)) {
            if(fi.flags & FSF_DIRECTORY) continue;
            size_t len = furi_string_size(fn);
            size_t ext = strlen(KEY_FILE_EXT);
            if(len > ext && strcmp(furi_string_get_cstr(fn) + len - ext, KEY_FILE_EXT) == 0) {
                furi_string_printf(app->selected_file_path, "%s/%s", STORAGE_PATH, furi_string_get_cstr(fn));
                submenu_add_item(app->submenu, furi_string_get_cstr(fn), idx, scene_main_menu_callback, app);
                idx++;
            }
        }
        furi_string_free(fn);
        storage_dir_close(dir);
    }
    storage_file_free(dir);
    furi_record_close(RECORD_STORAGE);
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewSubmenu);
}

static bool scene_file_select_on_event(void* context, SceneManagerEvent event) {
    BitLockerApp* app = context;
    if(event.type == SceneManagerEventTypeCustom) {
        if(read_key_from_file(app->selected_file_path, app->key_buffer, RECOVERY_KEY_LEN)) {
            furi_hal_usb_set_config(&usb_hid, NULL);
            furi_delay_ms(1000);
            input_recovery_key(app);
        }
        return true;
    }
    return false;
}

static void scene_file_select_on_exit(void* context) { submenu_reset(((BitLockerApp*)context)->submenu); }

static void scene_input_progress_on_enter(void* context) {
    BitLockerApp* app = context;
    uint32_t state = scene_manager_get_scene_state(app->scene_manager, SceneSaveKey);
    popup_reset(app->popup);
    if(state == 0) {
        popup_set_header(app->popup, "Saved!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(app->popup, "Key saved to SD card", 64, 36, AlignCenter, AlignTop);
    } else if(state == 1) {
        popup_set_header(app->popup, "Error!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(app->popup, "Invalid key format\\nNeed 48 digits", 64, 36, AlignCenter, AlignTop);
    } else {
        popup_set_header(app->popup, "Error!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(app->popup, "Failed to save file", 64, 36, AlignCenter, AlignTop);
    }
    popup_set_timeout(app->popup, 2000);
    popup_set_timeout_enabled(app->popup);
    popup_set_callback(app->popup, NULL);
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewPopup);
}

static bool scene_input_progress_on_event(void* context, SceneManagerEvent event) {
    BitLockerApp* app = context;
    if(event.type == SceneManagerEventTypeBack) {
        scene_manager_search_and_switch_to_previous_scene(app->scene_manager, SceneMainMenu);
        return true;
    }
    return false;
}

static void scene_input_progress_on_exit(void* context) { popup_reset(((BitLockerApp*)context)->popup); }

static void (*const scene_on_enter_handlers[])(void*) = {
    scene_main_menu_on_enter, scene_save_key_on_enter, scene_settings_on_enter,
    scene_file_select_on_enter, scene_input_progress_on_enter,
};
static bool (*const scene_on_event_handlers[])(void*, SceneManagerEvent) = {
    scene_main_menu_on_event, scene_save_key_on_event, scene_settings_on_event,
    scene_file_select_on_event, scene_input_progress_on_event,
};
static void (*const scene_on_exit_handlers[])(void*) = {
    scene_main_menu_on_exit, scene_save_key_on_exit, scene_settings_on_exit,
    scene_file_select_on_exit, scene_input_progress_on_exit,
};

static const SceneManagerHandlers scene_handlers = {
    .scene = {{ .on_enter_handlers = scene_on_enter_handlers,
                .on_event_handlers = scene_on_event_handlers,
                .on_exit_handlers = scene_on_exit_handlers }},
    .scene_num = SceneCount,
};

static bool view_dispatcher_custom_callback(void* context, uint32_t custom_event) {
    return scene_manager_handle_custom_event(((BitLockerApp*)context)->scene_manager, custom_event);
}
static bool view_dispatcher_navigation_callback(void* context) {
    return scene_manager_handle_back_event(((BitLockerApp*)context)->scene_manager);
}

static BitLockerApp* app_alloc(void) {
    BitLockerApp* app = malloc(sizeof(BitLockerApp));
    app->scene_manager = scene_manager_alloc(&scene_handlers, app);
    app->view_dispatcher = view_dispatcher_alloc();
    view_dispatcher_set_event_callback_context(app->view_dispatcher, app);
    view_dispatcher_set_custom_event_callback(app->view_dispatcher, view_dispatcher_custom_callback);
    view_dispatcher_set_navigation_event_callback(app->view_dispatcher, view_dispatcher_navigation_callback);

    app->submenu = submenu_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewSubmenu, submenu_get_view(app->submenu));
    app->text_input = text_input_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewTextInput, text_input_get_view(app->text_input));
    app->popup = popup_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewPopup, popup_get_view(app->popup));
    app->settings_list = variable_item_list_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewSettings, variable_item_list_get_view(app->settings_list));

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

int32_t bitlocker_key_manager_app(void* p) {
    UNUSED(p);
    BitLockerApp* app = app_alloc();
    Gui* gui = furi_record_open(RECORD_GUI);
    view_dispatcher_attach_to_gui(app->view_dispatcher, gui, ViewDispatcherTypeFullscreen);
    scene_manager_next_scene(app->scene_manager, SceneMainMenu);
    view_dispatcher_run(app->view_dispatcher);
    view_dispatcher_detach_from_gui(app->view_dispatcher);
    furi_record_close(RECORD_GUI);
    app_free(app);
    return 0;
}`

// ========================= Types =========================

type FileId = 'main' | 'fam' | 'workflow'

// ========================= App Component =========================

function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'code' | 'ci'>('overview')
  const [activeFile, setActiveFile] = useState<FileId>('main')
  const [copied, setCopied] = useState(false)

  const files: Record<FileId, { name: string; content: string }> = {
    main: { name: 'bitlocker_key_manager.c', content: MAIN_C_CODE },
    fam: { name: 'application.fam', content: APPLICATION_FAM },
    workflow: { name: '.github/workflows/build.yml', content: BUILD_YML },
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(files[activeFile].content)
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

  const handleDownloadAll = () => {
    handleDownload('bitlocker_key_manager.c', MAIN_C_CODE)
    setTimeout(() => handleDownload('application.fam', APPLICATION_FAM), 200)
    setTimeout(() => handleDownload('build.yml', BUILD_YML), 400)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="bg-gray-900 border-b border-orange-500/30">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <div className="w-12 h-12 bg-orange-500 rounded-lg flex items-center justify-center shadow-lg shadow-orange-500/20">
            <svg viewBox="0 0 24 24" className="w-8 h-8 text-gray-900" fill="currentColor">
              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/>
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-orange-400">BitLocker Key Manager</h1>
            <p className="text-sm text-gray-400">Flipper Zero — SHA Versioning via GitHub Actions</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-full border border-green-500/30">
              ● CI/CD Ready
            </span>
            <span className="px-2 py-1 bg-orange-500/20 text-orange-400 text-xs rounded-full border border-orange-500/30 font-mono">
              SHA Versioning
            </span>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-gray-900/50 border-b border-gray-800 sticky top-0 z-10 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 flex gap-1">
          {([
            { id: 'overview', label: '📋 Overview' },
            { id: 'code', label: '💻 Source Code' },
            { id: 'ci', label: '⚙️ CI/CD' },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === tab.id
                  ? 'border-orange-500 text-orange-400'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {tab.label}
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
            files={files}
            copied={copied}
            onCopy={handleCopy}
            onDownload={handleDownload}
            onDownloadAll={handleDownloadAll}
          />
        )}
        {activeTab === 'ci' && (
          <CISection
            buildYml={BUILD_YML}
            onDownload={handleDownload}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="bg-gray-900 border-t border-gray-800 py-6 mt-12">
        <div className="max-w-6xl mx-auto px-4 text-center text-gray-500 text-sm">
          <p>Flipper Zero BitLocker Recovery Key Manager</p>
          <p className="mt-1">Build & distributed via GitHub Actions · SHA Versioning</p>
          <p className="mt-1">⚠️ Use responsibly. Only for legitimate recovery purposes.</p>
        </div>
      </footer>
    </div>
  )
}

// ========================= Overview Section =========================

function OverviewSection() {
  return (
    <div className="space-y-8">
      <div className="bg-gradient-to-br from-orange-500/10 to-orange-600/5 border border-orange-500/20 rounded-xl p-8">
        <h2 className="text-2xl font-bold text-orange-400 mb-4">
          🔐 BitLocker Recovery Key Manager
        </h2>
        <p className="text-gray-300 leading-relaxed mb-4">
          Flipper Zero上でBitLocker回復キーを管理するアプリケーションです。
          回復キーをSDカードのtxtファイルとして保存し、必要に応じてUSB HID（BadUSB）経由で
          自動入力できます。
        </p>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <p className="text-sm text-gray-400">
            <strong className="text-green-400">📦 ビルド・配布:</strong> GitHub Actionsによる自動ビルド。
            コミットSHAでバージョン管理。Releasesから.fapファイルをダウンロードしてSDカードに配置するだけで使用可能。
          </p>
        </div>
      </div>

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

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h3 className="text-lg font-bold text-gray-200 mb-4">入力モード詳細</h3>
          <div className="space-y-4">
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
              <h4 className="font-bold text-green-400 mb-2">🔢 Digits Mode</h4>
              <p className="text-sm text-gray-400 mb-2">テンキー/数字キーで直接入力</p>
              <div className="font-mono text-xs text-gray-300 space-y-1">
                <p>0-9 → 数字キー 0-9</p>
                <p>- → マイナスキー</p>
                <p>最後 → Enter</p>
              </div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
              <h4 className="font-bold text-purple-400 mb-2">⌨️ F-Keys Mode</h4>
              <p className="text-sm text-gray-400 mb-2">ファンクションキーで数字を表現</p>
              <div className="font-mono text-xs text-gray-300 space-y-1">
                <p>F1=1, F2=2, ... F9=9, F10=0</p>
                <p>F11 → ハイフン (-)</p>
                <p>F12 → Enter</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h3 className="text-lg font-bold text-gray-200 mb-4">📥 使い方（Actionsからダウンロード後）</h3>
          <div className="space-y-4">
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
              <h4 className="font-bold text-orange-400 mb-2">1. .fapファイルをSDカードに配置</h4>
              <p className="text-xs text-gray-400">
                Releasesからダウンロード → <code className="bg-gray-700 px-1 rounded">/ext/apps/Tools/</code> にコピー
              </p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
              <h4 className="font-bold text-orange-400 mb-2">2. キーを保存</h4>
              <p className="text-xs text-gray-400">
                Apps → Tools → BitLocker Key Mgr → Save Recovery Key → 48桁入力
              </p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
              <h4 className="font-bold text-orange-400 mb-2">3. キーを自動入力</h4>
              <p className="text-xs text-gray-400">
                Input Recovery Key → ファイル選択 → USB接続PCに自動入力
              </p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
              <h4 className="font-bold text-orange-400 mb-2">4. 入力モード切替</h4>
              <p className="text-xs text-gray-400">
                Settings → Input Mode → Digits / F-Keys
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">BitLocker回復キー形式</h3>
        <div className="bg-gray-800 rounded-lg p-4 font-mono text-sm">
          <p className="text-orange-400">XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX</p>
          <p className="text-gray-500 mt-2">48桁の数字（6グループ × 8桁）、ハイフン区切り</p>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-3">
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

function FeatureCard({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-orange-500/30 transition-colors">
      <div className="text-3xl mb-3">{icon}</div>
      <h3 className="font-bold text-gray-200 mb-2">{title}</h3>
      <p className="text-sm text-gray-400 leading-relaxed">{description}</p>
    </div>
  )
}

// ========================= Code Section =========================

function CodeSection({
  activeFile,
  setActiveFile,
  files,
  copied,
  onCopy,
  onDownload,
  onDownloadAll,
}: {
  activeFile: FileId
  setActiveFile: (f: FileId) => void
  files: Record<FileId, { name: string; content: string }>
  copied: boolean
  onCopy: () => void
  onDownload: (filename: string, content: string) => void
  onDownloadAll: () => void
}) {
  const currentFile = files[activeFile]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-1 bg-gray-900 rounded-lg p-1 flex-wrap">
          {(Object.keys(files) as FileId[]).map((fileId) => (
            <button
              key={fileId}
              onClick={() => setActiveFile(fileId)}
              className={`px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                activeFile === fileId
                  ? 'bg-orange-500 text-gray-900'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {files[fileId].name}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCopy}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm font-medium transition-colors"
          >
            {copied ? '✅ Copied!' : '📋 Copy'}
          </button>
          <button
            onClick={() => onDownload(currentFile.name, currentFile.content)}
            className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition-colors"
          >
            ⬇️ Download
          </button>
          <button
            onClick={onDownloadAll}
            className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded-lg text-sm font-medium transition-colors"
          >
            📦 Download All
          </button>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
          <span className="text-sm text-gray-400 font-mono">{currentFile.name}</span>
          <span className="text-xs text-gray-500">
            {currentFile.content.split('\n').length} lines
          </span>
        </div>
        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          <pre className="p-4 text-sm font-mono leading-relaxed">
            <code className="text-gray-300">
              {currentFile.content.split('\n').map((line, i) => (
                <div key={i} className="flex hover:bg-gray-800/50">
                  <span className="text-gray-600 select-none w-12 text-right pr-4 flex-shrink-0">
                    {i + 1}
                  </span>
                  <span className={getLineColor(line)}>{line}</span>
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

// ========================= CI/CD Section =========================

function CISection({ buildYml, onDownload }: { buildYml: string; onDownload: (f: string, c: string) => void }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(buildYml)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="bg-gradient-to-br from-blue-500/10 to-purple-600/5 border border-blue-500/20 rounded-xl p-8">
        <h2 className="text-2xl font-bold text-blue-400 mb-4">⚙️ GitHub Actions — 自動ビルド & 配布</h2>
        <p className="text-gray-300 leading-relaxed">
          GitHub Actionsのみでビルド・配布を完結。プッシュするだけで自動的にFlipper Zero用.fapファイルがビルドされ、
          Releasesからダウンロード可能。バージョンはコミットSHAで管理。
        </p>
      </div>

      {/* Pipeline */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-6">ビルドパイプライン</h3>
        <div className="flex flex-col md:flex-row items-center gap-4">
          <PipelineStep icon="🔄" label="Trigger" sublabel="push / PR / schedule" color="blue" />
          <Arrow />
          <PipelineStep icon="🔨" label="Build (dev)" sublabel="ufbt build" color="orange" />
          <Arrow />
          <PipelineStep icon="🔨" label="Build (release)" sublabel="ufbt build" color="orange" />
          <Arrow />
          <PipelineStep icon="🔍" label="Lint" sublabel="clang-format" color="yellow" />
          <Arrow />
          <PipelineStep icon="🚀" label="Release" sublabel="SHA tag + .fap" color="green" />
        </div>
      </div>

      {/* SHA Versioning */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">🏷️ SHAバージョニング</h3>
        <div className="bg-gray-800/30 rounded-lg p-4 border border-gray-700 mb-4">
          <div className="flex flex-col md:flex-row items-center gap-3 text-xs">
            <div className="bg-gray-800 rounded px-3 py-2 border border-gray-600">
              <p className="text-gray-500">application.fam</p>
              <p className="font-mono text-yellow-400">fap_version="0.0.0"</p>
            </div>
            <span className="text-gray-500">→</span>
            <div className="bg-gray-800 rounded px-3 py-2 border border-blue-500/50">
              <p className="text-gray-500">CI: sed で置換</p>
              <p className="font-mono text-blue-400">fap_version="a1b2c3d"</p>
            </div>
            <span className="text-gray-500">→</span>
            <div className="bg-gray-800 rounded px-3 py-2 border border-green-500/50">
              <p className="text-gray-500">Release Tag</p>
              <p className="font-mono text-green-400">a1b2c3d</p>
            </div>
            <span className="text-gray-500">→</span>
            <div className="bg-gray-800 rounded px-3 py-2 border border-orange-500/50">
              <p className="text-gray-500">Artifact</p>
              <p className="font-mono text-orange-400">...-a1b2c3d-dev.fap</p>
            </div>
          </div>
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          <div className="bg-gray-800 rounded-lg p-4 text-center">
            <p className="text-2xl mb-1">🏷️</p>
            <p className="text-sm font-bold text-gray-200">SHAタグ</p>
            <p className="text-xs text-gray-500 mt-1">タグ名 = コミットのショートSHA（7桁）</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-4 text-center">
            <p className="text-2xl mb-1">🔄</p>
            <p className="text-sm font-bold text-gray-200">動的バージョン</p>
            <p className="text-xs text-gray-500 mt-1">sedでFAMのバージョンをSHAに書き換え</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-4 text-center">
            <p className="text-2xl mb-1">📎</p>
            <p className="text-sm font-bold text-gray-200">SHA付きバイナリ</p>
            <p className="text-xs text-gray-500 mt-1">アーティファクト名にSHAを含む</p>
          </div>
        </div>
      </div>

      {/* Triggers */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h3 className="text-lg font-bold text-gray-200 mb-4">🎯 トリガー</h3>
          <ul className="space-y-3 text-sm text-gray-300">
            <li className="flex items-start gap-2">
              <span className="text-blue-400">●</span>
              <div><strong>push</strong> — main/masterブランチ</div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-400">●</span>
              <div><strong>pull_request</strong> — PR作成・更新</div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-400">●</span>
              <div><strong>schedule</strong> — 毎日01:00 UTC</div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-400">●</span>
              <div><strong>workflow_dispatch</strong> — 手動実行</div>
            </li>
          </ul>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h3 className="text-lg font-bold text-gray-200 mb-4">📦 ビルドターゲット</h3>
          <div className="space-y-4">
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-3 h-3 bg-orange-500 rounded-full"></span>
                <strong className="text-orange-400">dev channel</strong>
              </div>
              <p className="text-xs text-gray-400">最新開発ファームウェア用</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-3 h-3 bg-green-500 rounded-full"></span>
                <strong className="text-green-400">release channel</strong>
              </div>
              <p className="text-xs text-gray-400">公式リリースファームウェア用</p>
            </div>
          </div>
        </div>
      </div>

      {/* Workflow Code */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
          <span className="text-sm text-gray-400 font-mono">.github/workflows/build.yml</span>
          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition-colors"
            >
              {copied ? '✅ Copied!' : '📋 Copy'}
            </button>
            <button
              onClick={() => onDownload('build.yml', buildYml)}
              className="px-3 py-1 bg-orange-600 hover:bg-orange-500 rounded text-xs font-medium transition-colors"
            >
              ⬇️ Download
            </button>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
          <pre className="p-4 text-sm font-mono leading-relaxed">
            <code className="text-gray-300">
              {buildYml.split('\n').map((line, i) => (
                <div key={i} className="flex hover:bg-gray-800/50">
                  <span className="text-gray-600 select-none w-12 text-right pr-4 flex-shrink-0">
                    {i + 1}
                  </span>
                  <span className={getYamlLineColor(line)}>{line}</span>
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>

      {/* Setup */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-bold text-gray-200 mb-4">🛠️ セットアップ</h3>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5">1</div>
            <div>
              <p className="text-sm font-bold text-gray-200">リポジトリに全ファイルをコミット</p>
              <pre className="text-xs text-gray-400 mt-1 bg-gray-800 px-2 py-1 rounded">
                <code>{"bitlocker_key_manager.c\napplication.fam\n.github/workflows/build.yml\nicon.png"}</code>
              </pre>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5">2</div>
            <div>
              <p className="text-sm font-bold text-gray-200">push → 自動ビルド開始</p>
              <p className="text-xs text-gray-500 mt-1">
                Actionsが自動で.fapをビルドし、main/masterならSHAタグのReleaseも作成
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5">3</div>
            <div>
              <p className="text-sm font-bold text-gray-200">Releasesから.fapをダウンロード</p>
              <div className="mt-2 bg-gray-800 rounded p-2 font-mono text-xs">
                <p className="text-gray-500"># Release例:</p>
                <p className="text-green-400">Tag: a1b2c3d</p>
                <p className="text-gray-500"># Artifacts:</p>
                <p className="text-orange-400">bitlocker_key_manager-a1b2c3d-dev.fap</p>
                <p className="text-orange-400">bitlocker_key_manager-a1b2c3d-release.fap</p>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5">4</div>
            <div>
              <p className="text-sm font-bold text-gray-200">SDカードに配置して完了</p>
              <p className="text-xs text-gray-500 mt-1">
                <code className="bg-gray-800 px-1 rounded">/ext/apps/Tools/</code> にコピー → Flipperで起動
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PipelineStep({ icon, label, sublabel, color }: { icon: string; label: string; sublabel: string; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'border-blue-500/50 bg-blue-500/10',
    orange: 'border-orange-500/50 bg-orange-500/10',
    yellow: 'border-yellow-500/50 bg-yellow-500/10',
    green: 'border-green-500/50 bg-green-500/10',
  }
  return (
    <div className={`flex flex-col items-center gap-1 px-4 py-3 rounded-lg border ${colorMap[color]}`}>
      <span className="text-2xl">{icon}</span>
      <span className="text-xs font-bold text-gray-200">{label}</span>
      <span className="text-[10px] text-gray-500">{sublabel}</span>
    </div>
  )
}

function Arrow() {
  return <span className="text-gray-600 text-xl hidden md:block">→</span>
}

function getYamlLineColor(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) return 'text-green-600'
  if (trimmed.startsWith('name:') || trimmed.startsWith('on:') || trimmed.startsWith('jobs:') || trimmed.startsWith('permissions:') || trimmed.startsWith('env:')) return 'text-blue-400'
  if (trimmed.startsWith('- name:') || trimmed.startsWith('- cron:')) return 'text-yellow-400'
  if (trimmed.includes('uses:')) return 'text-purple-400'
  if (trimmed.includes('${{')) return 'text-orange-400'
  return ''
}

export default App
