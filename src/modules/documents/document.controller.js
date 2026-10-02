import { createDocument , getDocument, listDocuments } from "./document.service.js";
import { createDocumentBody, documentIdParams, listDocumentsQuery } from "./document.schema.js";

export async function uploadDocument(req, res, next) {
    try{
        const { title } = createDocumentBody.parse(req.body ?? {});
        const { document, created } = await createDocument({
            tenantId: req.auth.tenantId,
            title,
            file: req.file,
        });

        if(created){
            return res.status(202).location(`/api/documents/${document.id}`).json(document);
        }
        res.status(200).json(document);
    }catch(error) { next(error); }
}
export async function getDocumentsById(req, res, next){
    try{
        const { id } = documentIdParams.parse(req.params);
        const document = await getDocument({ tenantId: req.auth.tenantId, documentId: id});
        res.json(document); 
    } catch(error) { next(error); }
}

export async function listDocumentsController(req, res, next){
    try{
        const query = listDocumentsQuery.parse(req.query);
        const result = await listDocuments({ tenantId: req.auth.tenantId, ...query });
        res.json(result);
    } catch(error) { next(error); }
}
