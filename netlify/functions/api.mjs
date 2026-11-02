// All /api/* requests. The app itself is built into ../dist/runtime.mjs.
import { handleRequest } from '../dist/runtime.mjs';

export default async (request, context) => handleRequest(request, context);

export const config = { path: '/api/*' };
