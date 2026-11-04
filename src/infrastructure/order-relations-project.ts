import type { AppState, AuthenticatedUser, OrderRelationsState } from '../entities/index';
import { prepareOrderRelationsUpdate } from '../domain/order-relations.js';
import { commitStateChange, type StateChangeSink } from '../application/state-change';

/** Edits never replace an order relation slice that changed while a form was open. */
export const orderRelationsFingerprint = (state: AppState) => JSON.stringify({
  projectId: state.project.id,
  orderRelations: state.orderRelations ?? null,
  contractValue: state.project.contractValue,
});

export function commitOrderRelationsProject(
  state: AppState,
  nextRelations: OrderRelationsState,
  identity: Pick<AuthenticatedUser, 'role' | 'name' | 'email'>,
  reason: string,
  expected: string,
  sink: StateChangeSink,
): void {
  if (expected !== orderRelationsFingerprint(state)) throw new Error('Заказ изменился, пока была открыта форма. Закройте её, проверьте новые сведения и повторите изменение.');
  const prepared = prepareOrderRelationsUpdate(state, nextRelations, identity, reason);
  if (!prepared.ok) throw new Error(prepared.error);
  const next: AppState = {
    ...state,
    orderRelations: prepared.orderRelations,
    project: {
      ...state.project,
      status: prepared.projectStatus,
      ...(prepared.contractValue !== undefined ? {
        contractValue: prepared.contractValue,
        ...(state.project.unknownFields ? { unknownFields: state.project.unknownFields.filter(field => field !== 'contractValue') } : {}),
      } : {}),
    },
  };
  commitStateChange({ state: next, action: 'order_relations_updated', summary: reason }, sink);
}
