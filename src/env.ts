import { parseEnv } from "@neon/env";
import config from "../neon.js";

export const env = parseEnv(config);
