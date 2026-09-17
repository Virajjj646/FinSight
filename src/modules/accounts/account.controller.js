import { createAccountSchema, listAccountsQuerySchema } from "./account.schema.js";
import { createAccount, listAccounts } from "./account.service.js";

export async function createAccountController(req,res,next){
    try{
        const data = createAccountSchema.parse(req.body);
        const account = await createAccount({tenantId: req.auth.tenantId, ...data});
        res.status(201).json(account);
    }catch(error){ next(error); }
}

export async function listAccountsController(req,res,next){
    try{
        const { type } = listAccountsQuerySchema.parse(req.query);
        const result = await listAccounts({tenantId: req.auth.tenantId, type});
        res.json(result);
    }catch(error){ next(error);}
}