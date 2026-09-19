import { AppError } from "../../lib/AppError.js";

export const allowedTransitions = {
    DRAFT: ["ISSUED", "VOID"],
    ISSUED: ["PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"],
    PARTIALLY_PAID: ["PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"],
    OVERDUE: ["PARTIALLY_PAID", "PAID", "VOID"],
    PAID: [],
    VOID: []
};

export function canTransition(from, to){
    return (allowedTransitions[from]?? []).includes(to);
}

export function assertTransition(from,to){
    if(!canTransition(from,to)){
        throw new AppError(
            `Cannot transition invoice from ${from} to ${to}`,
            422,
            "ILLEGAL_TRANSITION"
        );
    }
}

export function statusThatCanReach(to){
    return Object.keys(allowedTransitions).filter((from) => canTransition(from,to));
}