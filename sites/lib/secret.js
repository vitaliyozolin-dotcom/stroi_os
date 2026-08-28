export const constantTimeEqual = (left, right) => {
  const leftBytes = new TextEncoder().encode(String(left));
  const rightBytes = new TextEncoder().encode(String(right));
  const size = Math.max(leftBytes.length, rightBytes.length, 1);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < size; index += 1) {
    mismatch |= (leftBytes[index % leftBytes.length] ?? 0) ^ (rightBytes[index % rightBytes.length] ?? 0);
  }
  return mismatch === 0;
};
