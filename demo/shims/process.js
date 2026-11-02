// Injected in place of Node's global `process` for the browser build.
export const process = { env: { DEMO_MODE: '1', DB_DRIVER: 'sqljs' }, argv: [], versions: {}, cwd: () => '/' };
