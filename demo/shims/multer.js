const passthrough = () => (_req, _res, next) => next();
export default function multer() { return { none: passthrough }; }
