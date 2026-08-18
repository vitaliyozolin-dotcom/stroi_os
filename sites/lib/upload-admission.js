const MAX_CONCURRENT_UPLOADS = 2;
let activeUploads = 0;

export const claimUploadAdmission = () => {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) return null;
  activeUploads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads = Math.max(0, activeUploads - 1);
  };
};
