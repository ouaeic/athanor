mod connection;
mod proxy;
mod ssh_install;

use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;
use uuid::Uuid;

#[derive(Default)]
struct FolderGrants(Mutex<HashMap<String, PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderGrant {
    token: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeEntry {
    name: String,
    relative_path: String,
    is_directory: bool,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapabilities {
    folder_picker: bool,
}

#[tauri::command]
fn native_capabilities() -> NativeCapabilities {
    NativeCapabilities {
        folder_picker: cfg!(desktop),
    }
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Path is outside the granted folder".into());
    }
    Ok(path.to_path_buf())
}

fn grant_root(grants: &State<FolderGrants>, token: &str) -> Result<PathBuf, String> {
    let guard = grants.0.lock().map_err(|_| "Folder grant is unavailable")?;
    guard
        .get(token)
        .cloned()
        .ok_or_else(|| "Folder permission has expired".into())
}

fn checked_path(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, String> {
    let relative = relative_path(relative)?;
    let mut candidate = root.to_path_buf();
    for component in relative.components() {
        candidate.push(component);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Symbolic links are not followed through a folder grant".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    if must_exist {
        let canonical = candidate
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !canonical.starts_with(root) {
            return Err("Path is outside the granted folder".into());
        }
        Ok(canonical)
    } else {
        Ok(candidate)
    }
}

#[tauri::command]
#[cfg(desktop)]
fn choose_folder(grants: State<FolderGrants>) -> Result<Option<FolderGrant>, String> {
    let Some(folder) = rfd::FileDialog::new().pick_folder() else {
        return Ok(None);
    };
    let canonical = folder.canonicalize().map_err(|error| error.to_string())?;
    let token = Uuid::new_v4().to_string();
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Folder")
        .to_owned();
    grants
        .0
        .lock()
        .map_err(|_| "Folder grant is unavailable")?
        .insert(token.clone(), canonical);
    Ok(Some(FolderGrant { token, name }))
}

#[tauri::command]
#[cfg(mobile)]
fn choose_folder(_grants: State<FolderGrants>) -> Result<Option<FolderGrant>, String> {
    Err("Native folder selection is not available on mobile".into())
}

#[tauri::command]
fn revoke_folder(grants: State<FolderGrants>, token: String) -> Result<(), String> {
    grants
        .0
        .lock()
        .map_err(|_| "Folder grant is unavailable")?
        .remove(&token);
    Ok(())
}

#[tauri::command]
fn list_local_folder(
    grants: State<FolderGrants>,
    token: String,
    relative: String,
) -> Result<Vec<NativeEntry>, String> {
    let root = grant_root(&grants, &token)?;
    let directory = checked_path(&root, &relative, true)?;
    let mut entries = Vec::new();
    for result in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = result.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        entries.push(NativeEntry {
            name,
            relative_path,
            is_directory: file_type.is_dir(),
            size_bytes: metadata.len(),
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then(left.name.cmp(&right.name))
    });
    Ok(entries)
}

#[tauri::command]
fn read_local_file(
    grants: State<FolderGrants>,
    token: String,
    relative: String,
) -> Result<Vec<u8>, String> {
    let root = grant_root(&grants, &token)?;
    let path = checked_path(&root, &relative, true)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 100 * 1024 * 1024
    {
        return Err("Only regular files up to 100 MiB may be read".into());
    }
    fs::read(path).map_err(|error| error.to_string())
}

fn deep_link_destination(raw: &str, local_origin: &str) -> Result<Option<Url>, String> {
    let link = Url::parse(raw).map_err(|_| "This is not an athanor link")?;
    if link.scheme() != "athanor"
        || !link.username().is_empty()
        || link.password().is_some()
        || link.query().is_some()
        || link.fragment().is_some()
    {
        return Err("This is not an athanor link".into());
    }
    let Some(kind @ ("task" | "workspace")) = link.host_str() else {
        return Ok(None);
    };
    let segments = link
        .path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() != 1 || Uuid::parse_str(segments[0]).is_err() {
        return Err("This athanor link does not contain a valid destination".into());
    }
    let mut destination =
        Url::parse(local_origin).map_err(|_| "The private client address is invalid")?;
    destination.set_path("/");
    destination.query_pairs_mut().append_pair(kind, segments[0]);
    Ok(Some(destination))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .manage(FolderGrants::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let profile_path = app.path().app_data_dir()?.join("server-profile.json");
            let pending_pairing_path = app.path().app_cache_dir()?.join("pending-pairing.json");
            let client = proxy::ClientState::load(profile_path, pending_pairing_path)?;
            let origin = tauri::async_runtime::block_on(proxy::start(client.clone()))?;
            let mut window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("The athanor main window configuration is unavailable")?
                .clone();
            window_config.url = tauri::WebviewUrl::External(origin.parse()?);
            let window = tauri::WebviewWindowBuilder::from_config(app, &window_config)?.build()?;

            let import_url = {
                let client = client.clone();
                let window = window.clone();
                let origin = origin.clone();
                move |raw: String| {
                    let client = client.clone();
                    let window = window.clone();
                    let origin = origin.clone();
                    tauri::async_runtime::spawn(async move {
                        let destination = match deep_link_destination(&raw, &origin) {
                            Ok(Some(destination)) => Some(destination),
                            Ok(None) => match client.import_deep_link(&raw).await {
                                Ok(()) => origin.parse().ok(),
                                Err(_) => None,
                            },
                            Err(_) => None,
                        };
                        if let Some(destination) = destination {
                            let _ = window.navigate(destination);
                        }
                        let _ = window.show();
                        let _ = window.set_focus();
                    });
                }
            };

            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    import_url(url.to_string());
                }
            }
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    import_url(url.to_string());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_capabilities,
            choose_folder,
            revoke_folder,
            list_local_folder,
            read_local_file
        ])
        .run(tauri::generate_context!())
        .expect("athanor native shell failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_and_absolute_paths() {
        assert!(relative_path("../secret").is_err());
        assert!(relative_path("/etc/passwd").is_err());
        assert!(relative_path("workspace/report.md").is_ok());
    }

    #[test]
    fn maps_valid_task_and_workspace_links_to_the_private_gateway() {
        let task_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        assert_eq!(
            deep_link_destination(
                &format!("athanor://task/{task_id}"),
                "http://localhost:49876"
            )
            .unwrap()
            .unwrap()
            .as_str(),
            format!("http://localhost:49876/?task={task_id}")
        );
        assert_eq!(
            deep_link_destination(
                &format!("athanor://workspace/{workspace_id}"),
                "http://localhost:49876"
            )
            .unwrap()
            .unwrap()
            .as_str(),
            format!("http://localhost:49876/?workspace={workspace_id}")
        );
        assert!(
            deep_link_destination("athanor://task/not-a-uuid", "http://localhost:49876").is_err()
        );
        assert!(
            deep_link_destination("athanor://pair/ticket", "http://localhost:49876")
                .unwrap()
                .is_none()
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_leave_a_grant() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("athanor-native-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        symlink("/", root.join("outside")).unwrap();
        let result = checked_path(&root, "outside/etc/passwd", true);
        fs::remove_dir_all(&root).unwrap();
        assert!(result.is_err());
    }
}
