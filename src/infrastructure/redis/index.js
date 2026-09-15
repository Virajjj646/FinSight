import { env } from "../../config/env.js";
import IORedis from "ioredis";

export const redis = new IORedis(
    env.REDIS_URL,{maxRetriesPerRequest : null}
);