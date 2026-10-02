import { createDocument , getDocument, getDocumentFile, listDocuments, retryDocument, deleteDocument } from "./document.service.js";
import { createDocumentBody, documentIdParams, listDocumentsQuery } from "./document.schema.js";
import { contentDisposition } from "../../lib/contentDisposition.js";

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

export async function getDocumentFileController(req, res, next){
    try{
        const { id } = documentIdParams.parse(req.params);
        const file = await getDocumentFile({ tenantId: req.auth.tenantId, documentId: id });
        const bytes = Buffer.from(file.bytes);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': String(bytes.length),
            // Titles default to the upload's file name, so drop a trailing .pdf
            // rather than sending "contract.pdf.pdf".
            'Content-Disposition': contentDisposition('inline', {
                baseName: file.title?.replace(/\.pdf$/i, ''),
                extension: '.pdf',
                fallbackName: file.documentId,
            }),
        });
        res.status(200).end(bytes);
    } catch(error) { next(error); }
}

export async function retryDocumentController(req, res, next){
    try{
        const { id } = documentIdParams.parse(req.params);
        const document = await retryDocument({ tenantId: req.auth.tenantId, documentId: id });
        res.status(202).json(document);
    } catch(error) { next(error); }
}

export async function deleteDocumentController(req, res, next){
    try{
        const { id } = documentIdParams.parse(req.params);
        await deleteDocument({ tenantId: req.auth.tenantId, documentId: id });
        res.status(204).end();
    } catch(error) { next(error); }
}

export async function listDocumentsController(req, res, next){
    try{
        const query = listDocumentsQuery.parse(req.query);
        const result = await listDocuments({ tenantId: req.auth.tenantId, ...query });
        res.json(result);
    } catch(error) { next(error); }
}
