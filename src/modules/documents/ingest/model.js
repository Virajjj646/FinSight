import { AutoTokenizer } from "@huggingface/transformers";

export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';

let tokenizerPromise;

export function getTokenizer(){
    tokenizerPromise ??= AutoTokenizer.from_pretrained(EMBEDDING_MODEL).catch((err) => {
        tokenizerPromise = undefined;
        throw err;
    });
    return tokenizerPromise;
}

export async function getTokenCounter() {
    const tokenizer = await getTokenizer();
    return (text) => tokenizer.encode(text).length;
}