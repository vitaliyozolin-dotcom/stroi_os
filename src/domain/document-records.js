export const projectDocumentCategories = { contract: 'Договор', act: 'Акт', invoice: 'Счёт', upd: 'УПД', waybill: 'ТН', specification: 'Спецификация', other: 'Прочее' };

export const validateDocumentDraft = (state, draft) => {
 if (!Object.hasOwn(projectDocumentCategories, draft.category) || !['draft', 'current', 'signed'].includes(draft.status) || !['incoming', 'outgoing', 'internal'].includes(draft.direction) || typeof draft.clientVisible !== 'boolean') return 'Проверьте тип, статус и видимость документа.';
 if (draft.documentDate) { const date = new Date(`${draft.documentDate}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.documentDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== draft.documentDate) return 'Укажите корректную дату документа.'; }
 if (draft.stageId && !state.stages.some(stage => stage.id === draft.stageId)) return 'Этап документа больше недоступен.';
 if (draft.counterpartyId && !state.counterparties.some(profile => profile.id === draft.counterpartyId)) return 'Контрагент документа больше недоступен.';
 return '';
};
export const prepareUploadedDocument = (state, draft, file, id, actor, now) => ({
 id, name: draft.name.trim() || file.name.replace(/\.[^.]+$/, ''), type: projectDocumentCategories[draft.category], category: draft.category, number: draft.number.trim() || undefined, documentDate: draft.documentDate || undefined, status: draft.status, direction: draft.direction, counterpartyId: draft.counterpartyId || undefined, stageId: draft.stageId || undefined, clientVisible: draft.clientVisible, signedAt: draft.status === 'signed' ? now : undefined, updatedAt: now, storageLocation: `ИКИОМА ОС / ${state.project.code} / Документы`, fileKey: file.key, fileName: file.name, mimeType: file.type, sizeBytes: file.size, uploadedAt: file.uploadedAt, uploadedBy: actor,
});

export const validUploadedDocumentFile = (projectId, file) => typeof file.key === 'string' && file.key.startsWith(`${projectId}/`) && !file.key.split('/').some(part => part === '..' || part === '.') && typeof file.name === 'string' && Boolean(file.name.trim()) && typeof file.type === 'string' && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 20*1024*1024 && Number.isFinite(Date.parse(file.uploadedAt));
