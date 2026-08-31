/**
 * Minimal stand-in for the `obsidian` module so unit tests can import plugin
 * source without an Obsidian runtime. Only the surface the tested modules
 * actually touch is implemented.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class Notice {}
export class ButtonComponent {}
export const Platform = { isDesktopApp: true, isMacOS: true, isWin: false, isLinux: false };
export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in tests; inject a Transport instead.");
}
