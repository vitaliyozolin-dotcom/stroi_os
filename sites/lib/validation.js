export const clean = (value, max = 240) => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
);

export const validProjectId = (value) => /^[a-zA-Z0-9._:-]{1,100}$/.test(value);

export const supportedDocument = (file) => {
  const extension = clean(file?.name, 240).toLocaleLowerCase('en-US').split('.').pop();
  return ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx', 'xls', 'xlsx'].includes(extension);
};

export const safeFileName = (value) => {
  const normalized = clean(value, 180).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, ' ').trim();
  return normalized || 'document';
};
