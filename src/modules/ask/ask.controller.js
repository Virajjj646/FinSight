import { askBody } from "./ask.schema.js";
import { askQuestion } from "./ask.service.js";

export async function postAsk(req,res,next){
    try{
        const { question, k } = askBody.parse(req.body ?? {});
        const { abstained, answer, citations, reason } = await askQuestion({
            tenantId: req.auth.tenantId,
            question,
            k,
        });
        res.json({ abstained, answer, citations, ...(reason && { reason }) });
    }catch (error) { next(error); }
}