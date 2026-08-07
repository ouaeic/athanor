interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

interface TauriDeepLink {
  getCurrent(): Promise<string[] | null>;
  onOpenUrl(handler: (urls: string[]) => void): Promise<() => void>;
}

const core = (): TauriCore | undefined => {
  const host = window as unknown as {
    __TAURI__?: { core?: TauriCore };
    __TAURI_INTERNALS__?: { invoke?: TauriCore['invoke'] };
  };
  return (
    host.__TAURI__?.core ??
    (host.__TAURI_INTERNALS__?.invoke ? { invoke: host.__TAURI_INTERNALS__.invoke } : undefined)
  );
};

const deepLink = (): TauriDeepLink | undefined => {
  const host = window as unknown as { __TAURI__?: { deepLink?: TauriDeepLink } };
  return host.__TAURI__?.deepLink;
};

/**
 * What an `athanor://` link asks the window to open, or nothing.
 *
 * A deep link arrives from outside the app — another application, a notification the desktop
 * handed on — so it is checked the same way an address bar entry would be: the scheme, the one
 * hostname, and an id shaped like the ids this box issues. Anything else opens nothing at all
 * rather than sending an arbitrary string to the API as a conversation id.
 */
export const nativeTarget = (
  raw: string
): { kind: 'task' | 'workspace'; id: string } | undefined => {
  try {
    const url = new URL(raw);
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    if (
      url.protocol !== 'athanor:' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
      !['task', 'workspace'].includes(url.hostname)
    )
      return undefined;
    return { kind: url.hostname as 'task' | 'workspace', id };
  } catch {
    return undefined;
  }
};

export const nativeBridge = {
  available: () => Boolean(core()),
  capabilities: () =>
    core()?.invoke<{ folderPicker: boolean }>('native_capabilities') ??
    Promise.resolve({ folderPicker: false }),
  onDeepLinks: async (handler: (url: string) => void) => {
    const plugin = deepLink();
    if (!plugin) return undefined;
    const current = await plugin.getCurrent();
    current?.forEach(handler);
    return plugin.onOpenUrl((urls) => urls.forEach(handler));
  },
  chooseFolder: () => core()?.invoke<{ token: string; name: string } | null>('choose_folder'),
  revokeFolder: (token: string) => core()?.invoke('revoke_folder', { token }),
  listFolder: (token: string, relative = '') =>
    core()?.invoke<
      Array<{ name: string; relativePath: string; isDirectory: boolean; sizeBytes: number }>
    >('list_local_folder', { token, relative }),
  readFile: (token: string, relative: string) =>
    core()?.invoke<number[]>('read_local_file', { token, relative }),
  /**
   * Raise a notification through the operating system rather than through Web Push.
   *
   * A packaged shell has no push subscription and never will: delivery was Web Push only, so on
   * desktop and mobile the box could tell the owner nothing at all. It does not need a delivery
   * route of its own - it is already polling for approvals and notices - so it raises the
   * notification locally when something arrives and the window is not being looked at.
   *
   * The plugin and its capability were already shipped and simply never called.
   */
  notify: async (title: string, body: string): Promise<boolean> => {
    const bridge = core();
    if (!bridge) return false;
    try {
      const granted = await bridge.invoke<boolean>('plugin:notification|is_permission_granted');
      if (!granted) {
        const outcome = await bridge.invoke<string>('plugin:notification|request_permission');
        if (outcome !== 'granted') return false;
      }
      await bridge.invoke('plugin:notification|notify', { options: { title, body } });
      return true;
    } catch {
      // A shell built without the plugin, or a platform that refused: the in-app notice is still
      // there, and there is nothing here worth interrupting anybody with.
      return false;
    }
  }
};
