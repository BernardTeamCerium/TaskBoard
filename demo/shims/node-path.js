const join = (...p) => p.filter(Boolean).join('/').replace(/\/+/g, '/');
const dirname = (p) => String(p).replace(/\/[^/]*$/, '') || '/';
const resolve = (...p) => join(...p);
export default { join, dirname, resolve };
export { join, dirname, resolve };
