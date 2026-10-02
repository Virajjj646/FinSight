import { enqueueMarkOverdue } from "../../infrastructure/queue/invoice.jobs.js";

export async function markOverdueController(req, res, next){
    try{
        const job = await enqueueMarkOverdue();
        res.status(202).json({ jobId: job.id });
    }catch(error){
        next(error);
    }
}
