import { randomUUID } from "node:crypto";

export function requestId(req,res,next){
    req.id = req.get("X-Request-Id") ?? randomUUID();
    res.setHeader("X-Request-Id", req.id);
    next();
}