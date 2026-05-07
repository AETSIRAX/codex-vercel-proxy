import { loadEnv } from "../src/env.js";
import { handleRequest } from "../src/index.js";

export default {
  async fetch(request: Request): Promise<Response> {
    return handleRequest(request, loadEnv());
  },
};
