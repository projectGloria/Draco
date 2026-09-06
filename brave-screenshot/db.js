export async function captureStore(mode, operation) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('frame-captures', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('captures', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('captures', mode);
      const request = operation(transaction.objectStore('captures'));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Image storage failed.'));
    });
  } finally { db.close(); }
}
