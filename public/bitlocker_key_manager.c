#include <furi.h>
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

    FuriString* file_path = furi_string_alloc_printf("%s/%s%s", STORAGE_PATH, filename, KEY_FILE_EXT);
    
    File* file = storage_file_alloc(storage);
    bool success = false;

    if(storage_file_open(file, furi_string_get_cstr(file_path), FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        uint16_t bytes_written = storage_file_write(file, key_data, strlen(key_data));
        success = (bytes_written == strlen(key_data));
        storage_file_close(file);
    }

    storage_file_free(file);
    furi_string_free(file_path);
    furi_record_close(RECORD_STORAGE);

    FURI_LOG_I(TAG, "Save key: %s, success: %d", filename, success);
    return success;
}

static bool read_key_from_file(const char* filepath, char* buffer, size_t buffer_size) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);
    bool success = false;

    if(storage_file_open(file, filepath, FSAM_READ, FSOM_OPEN_EXISTING)) {
        uint16_t bytes_read = storage_file_read(file, buffer, buffer_size - 1);
        if(bytes_read > 0) {
            buffer[bytes_read] = '\0';
            // Trim whitespace
            for(int i = bytes_read - 1; i >= 0; i--) {
                if(buffer[i] == '\n' || buffer[i] == '\r' || buffer[i] == ' ') {
                    buffer[i] = '\0';
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

    for(int i = 0; key[i] != '\0'; i++) {
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

    return (digit_count == 48 && hyphen_count == 5 && current_group == DIGITS_PER_GROUP);
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

    int group = 0;
    int digit_in_group = 0;

    for(int i = 0; key[i] != '\0'; i++) {
        if(key[i] == '-') {
            // Type hyphen
            hid_type_hyphen();
            group++;
            digit_in_group = 0;
            furi_delay_ms(GROUP_DELAY_MS);
        } else {
            // Type digit
            if(app->input_mode == InputModeDigits) {
                hid_type_digit_digits_mode(key[i]);
            } else {
                hid_type_digit_fkey_mode(key[i]);
            }
            digit_in_group++;
        }
    }

    // Press Enter at the end
    furi_delay_ms(100);
    hid_type_enter();

    FURI_LOG_I(TAG, "Key input complete");
}

/* ========================= Scene Callbacks ========================= */

// Submenu callbacks
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

// Text input callback
static void scene_save_key_callback(void* context) {
    BitLockerApp* app = context;
    
    // Validate key
    if(!validate_recovery_key(app->key_buffer)) {
        scene_manager_set_scene_state(app->scene_manager, SceneSaveKey, 1); // error
        scene_manager_next_scene(app->scene_manager, SceneInputProgress);
        return;
    }

    // Generate filename from timestamp
    FuriString* filename = furi_string_alloc();
    uint32_t timestamp = furi_hal_rtc_get_timestamp();
    furi_string_printf(filename, "key_%lu", timestamp);

    bool saved = save_key_to_file(furi_string_get_cstr(filename), app->key_buffer);
    
    furi_string_free(filename);

    if(saved) {
        scene_manager_set_scene_state(app->scene_manager, SceneSaveKey, 0); // success
    } else {
        scene_manager_set_scene_state(app->scene_manager, SceneSaveKey, 2); // file error
    }
    scene_manager_next_scene(app->scene_manager, SceneInputProgress);
}

// Settings callback
static void scene_settings_enter_callback(void* context, uint32_t index) {
    UNUSED(context);
    UNUSED(index);
}

static void scene_settings_change_callback(void* context, uint32_t index) {
    BitLockerApp* app = context;
    if(index == 0) {
        // Input mode changed
        VariableItem* item = variable_item_list_get(app->settings_list, 0);
        uint8_t mode_idx = variable_item_get_current_value_index(item);
        app->input_mode = (InputMode)mode_idx;
        
        if(mode_idx == 0) {
            variable_item_set_current_value_text(item, "Digits");
        } else {
            variable_item_set_current_value_text(item, "F-Keys");
        }
    }
}

/* ========================= Scene Handlers ========================= */

// Main Menu Scene
static void scene_main_menu_on_enter(void* context) {
    BitLockerApp* app = context;
    Submenu* submenu = app->submenu;

    submenu_reset(submenu);
    submenu_set_header(submenu, "BitLocker Key Mgr", 64, 2, AlignCenter, AlignTop);
    submenu_add_item(submenu, "Save Recovery Key", 0, scene_main_menu_callback, app);
    submenu_add_item(submenu, "Input Recovery Key", 1, scene_main_menu_callback, app);
    submenu_add_item(submenu, "Settings", 2, scene_main_menu_callback, app);

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

// Save Key Scene
static void scene_save_key_on_enter(void* context) {
    BitLockerApp* app = context;
    TextInput* text_input = app->text_input;

    text_input_reset(text_input);
    text_input_set_header_text(text_input, "Enter 48-digit key\n(XXXXXX-XXXXXX-...)");
    text_input_set_result_callback(
        text_input,
        scene_save_key_callback,
        app,
        app->key_buffer,
        RECOVERY_KEY_LEN,
        true);

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

// Input Progress / Result Scene
static void scene_input_progress_on_enter(void* context) {
    BitLockerApp* app = context;
    Popup* popup = app->popup;
    uint32_t state = scene_manager_get_scene_state(app->scene_manager, SceneSaveKey);

    popup_reset(popup);

    // Check if we're in "input key" mode or "save result" mode
    if(scene_manager_has_previous_scene(app->scene_manager, SceneFileSelect)) {
        // We're inputting a key
        popup_set_header(popup, "Typing Key...", 64, 20, AlignCenter, AlignTop);
        popup_set_text(popup, "USB HID Active", 64, 36, AlignCenter, AlignTop);
        view_dispatcher_switch_to_view(app->view_dispatcher, ViewPopup);

        // Perform the input
        input_recovery_key(app);

        // Show completion
        popup_set_header(popup, "Complete!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(popup, "Key typed successfully", 64, 36, AlignCenter, AlignTop);
        popup_set_timeout(popup, 2000);
        popup_set_timeout_enabled(popup);
        popup_set_callback(popup, NULL);
    } else if(state == 0) {
        // Save success
        popup_set_header(popup, "Saved!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(popup, "Key saved to SD card", 64, 36, AlignCenter, AlignTop);
        popup_set_icon(popup, 0, 0, NULL);
        popup_set_timeout(popup, 2000);
        popup_set_timeout_enabled(popup);
        popup_set_callback(popup, NULL);
    } else if(state == 1) {
        // Validation error
        popup_set_header(popup, "Error!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(popup, "Invalid key format\nNeed 48 digits (6x8)", 64, 36, AlignCenter, AlignTop);
        popup_set_timeout(popup, 3000);
        popup_set_timeout_enabled(popup);
        popup_set_callback(popup, NULL);
    } else {
        // File error
        popup_set_header(popup, "Error!", 64, 20, AlignCenter, AlignTop);
        popup_set_text(popup, "Failed to save file", 64, 36, AlignCenter, AlignTop);
        popup_set_timeout(popup, 3000);
        popup_set_timeout_enabled(popup);
        popup_set_callback(popup, NULL);
    }

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

static void scene_input_progress_on_exit(void* context) {
    BitLockerApp* app = context;
    popup_reset(app->popup);
}

// Settings Scene
static void scene_settings_on_enter(void* context) {
    BitLockerApp* app = context;
    VariableItemList* list = app->settings_list;

    variable_item_list_reset(list);

    VariableItem* item = variable_item_list_add(list, "Input Mode", 2, scene_settings_change_callback, app);
    if(app->input_mode == InputModeDigits) {
        variable_item_set_current_value_index(item, 0);
        variable_item_set_current_value_text(item, "Digits");
    } else {
        variable_item_set_current_value_index(item, 1);
        variable_item_set_current_value_text(item, "F-Keys");
    }

    variable_item_list_set_enter_callback(list, scene_settings_enter_callback, app);

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

// File Select Scene (using submenu to list files)
static void scene_file_select_on_enter(void* context) {
    BitLockerApp* app = context;
    Submenu* submenu = app->submenu;

    submenu_reset(submenu);
    submenu_set_header(submenu, "Select Key File", 64, 2, AlignCenter, AlignTop);

    // List files from SD card
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* dir = storage_file_alloc(storage);

    if(storage_dir_open(dir, STORAGE_PATH)) {
        FileInfo file_info;
        FuriString* filename = furi_string_alloc();
        FuriString* filepath = furi_string_alloc();
        uint32_t item_index = 0;

        while(storage_dir_read(dir, &file_info, furi_string_get_ansi(filename), 255)) {
            if(file_info.flags & FSF_DIRECTORY) continue;
            
            // Check extension
            size_t name_len = furi_string_size(filename);
            size_t ext_len = strlen(KEY_FILE_EXT);
            if(name_len > ext_len) {
                const char* name_str = furi_string_get_cstr(filename);
                if(strcmp(name_str + name_len - ext_len, KEY_FILE_EXT) == 0) {
                    furi_string_printf(filepath, "%s/%s", STORAGE_PATH, name_str);
                    submenu_add_item(
                        submenu,
                        name_str,
                        item_index,
                        scene_main_menu_callback, // reuse callback
                        app);
                    // Store file path for later use
                    strncpy(app->selected_file_path, furi_string_get_cstr(filepath), 255);
                    item_index++;
                }
            }
        }

        furi_string_free(filename);
        furi_string_free(filepath);
        storage_dir_close(dir);
    }

    storage_file_free(dir);
    furi_record_close(RECORD_STORAGE);

    if(item_index == 0) {
        submenu_add_item(submenu, "(No files found)", 99, scene_main_menu_callback, app);
    }

    view_dispatcher_switch_to_view(app->view_dispatcher, ViewSubmenu);
}

static bool scene_file_select_on_event(void* context, SceneManagerEvent event) {
    BitLockerApp* app = context;
    if(event.type == SceneManagerEventTypeCustom) {
        // File selected - read and input
        if(read_key_from_file(app->selected_file_path, app->key_buffer, RECOVERY_KEY_LEN)) {
            scene_manager_next_scene(app->scene_manager, SceneInputProgress);
        }
        return true;
    }
    return false;
}

static void scene_file_select_on_exit(void* context) {
    BitLockerApp* app = context;
    submenu_reset(app->submenu);
}

/* ========================= Scene Table ========================= */

static void (*const scene_on_enter_handlers[])(void*) = {
    scene_main_menu_on_enter,
    scene_save_key_on_enter,
    scene_file_select_on_enter,
    scene_settings_on_enter,
    scene_file_select_on_enter,  // reuse for file select
    scene_input_progress_on_enter,
};

static bool (*const scene_on_event_handlers[])(void*, SceneManagerEvent) = {
    scene_main_menu_on_event,
    scene_save_key_on_event,
    scene_file_select_on_event,
    scene_settings_on_event,
    scene_file_select_on_event,
    scene_input_progress_on_event,
};

static void (*const scene_on_exit_handlers[])(void*) = {
    scene_main_menu_on_exit,
    scene_save_key_on_exit,
    scene_file_select_on_exit,
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
    .tick_event = NULL,
    .custom_event_handler = NULL,
};

/* ========================= View Dispatcher Callback ========================= */

static bool view_dispatcher_custom_callback(void* context, uint32_t custom_event) {
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

    // Scene manager
    app->scene_manager = scene_manager_alloc(&scene_handlers, app);

    // View dispatcher
    app->view_dispatcher = view_dispatcher_alloc();
    view_dispatcher_set_event_callback_context(app->view_dispatcher, app);
    view_dispatcher_set_custom_event_callback(app->view_dispatcher, view_dispatcher_custom_callback);
    view_dispatcher_set_navigation_event_callback(app->view_dispatcher, view_dispatcher_navigation_callback);

    // GUI modules
    app->submenu = submenu_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewSubmenu, submenu_get_view(app->submenu));

    app->text_input = text_input_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewTextInput, text_input_get_view(app->text_input));

    app->popup = popup_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewPopup, popup_get_view(app->popup));

    app->settings_list = variable_item_list_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewSettings, variable_item_list_get_view(app->settings_list));

    // Init data
    memset(app->key_buffer, 0, RECOVERY_KEY_LEN);
    memset(app->selected_file_path, 0, sizeof(app->selected_file_path));
    app->input_mode = InputModeDigits;
    app->usb_connected = false;

    // Ensure storage directory exists
    ensure_storage_dir();

    return app;
}

static void app_free(BitLockerApp* app) {
    // Remove views
    view_dispatcher_remove_view(app->view_dispatcher, ViewSubmenu);
    view_dispatcher_remove_view(app->view_dispatcher, ViewTextInput);
    view_dispatcher_remove_view(app->view_dispatcher, ViewPopup);
    view_dispatcher_remove_view(app->view_dispatcher, ViewSettings);

    // Free GUI modules
    submenu_free(app->submenu);
    text_input_free(app->text_input);
    popup_free(app->popup);
    variable_item_list_free(app->settings_list);

    // Free dispatcher and scene manager
    view_dispatcher_free(app->view_dispatcher);
    scene_manager_free(app->scene_manager);

    free(app);
}

/* ========================= Entry Point ========================= */

int32_t bitlocker_key_manager_app(void* p) {
    UNUSED(p);

    BitLockerApp* app = app_alloc();

    Gui* gui = furi_record_open(RECORD_GUI);
    view_dispatcher_attach_to_gui(app->view_dispatcher, gui, ViewDispatcherTypeFullscreen);

    // Start from main menu
    scene_manager_next_scene(app->scene_manager, SceneMainMenu);

    view_dispatcher_run(app->view_dispatcher);

    view_dispatcher_detach_from_gui(app->view_dispatcher);
    furi_record_close(RECORD_GUI);

    app_free(app);
    return 0;
}
