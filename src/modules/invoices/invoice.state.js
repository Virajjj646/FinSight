const allowedTransitions = {
    DRAFT: ["ISSUED", "VOID"],
    ISSUED: ["PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"],
    PARTIALLY_PAID: ["PAID", "OVERDUE", "VOID"],
    OVERDUE: ["PARTIALLY_PAID", "PAID", "VOID"],
    PAID: [],
    VOID: []
};

export function canTransition(from, to){
    return allowedTransitions[from]?.includes(to) ?? false;
}