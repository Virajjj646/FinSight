import { createMemberSchema } from "./member.schema.js";
import { createMember, listMembers } from "./member.service.js";

export async function listMembersController(req, res, next) {
  try {
    const data = await listMembers({ tenantId: req.auth.tenantId });
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export async function createMemberController(req, res, next) {
  try {
    const data = createMemberSchema.parse(req.body ?? {});
    const result = await createMember({ tenantId: req.auth.tenantId, ...data });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}
