const storeNames = { store: 'Store preview' };

export function previewView(snapshot, pull) {
  const stale = !!snapshot && (snapshot.headSha !== pull.headSha || (!!snapshot.baseSha && !!pull.baseSha && snapshot.baseSha !== pull.baseSha) || (!!snapshot.prNumber && snapshot.prNumber !== pull.number));
  const markets = ['store'].map(market => {
    const source = snapshot?.markets?.find(item => item.market === market);
    const links = !stale && source?.status === 'ready' ? (source.links || []).flatMap(link => {
      try {
        const url = new URL(link.url);
        return url.protocol === 'https:' ? [{ label: link.label || 'Open preview', url: url.href }] : [];
      } catch { return []; }
    }) : [];
    return { market, name: storeNames[market], status: stale ? 'stale' : source?.status || 'unavailable', links, error: source?.error || null };
  });
  return { stale, busy: !stale && ['queued', 'running'].includes(snapshot?.status), markets };
}

export function newerPreview(current, incoming) {
  if (!current) return incoming || null;
  if (!incoming) return current;
  const timestamp = item => Date.parse(item.updatedAt || item.createdAt || '') || 0;
  return timestamp(incoming) >= timestamp(current) ? incoming : current;
}

// Construction is inert: the caller must explicitly load or generate previews.
export function createPreviewRequests({ request, onStart, onResult, onError, onFinish }) {
  let disposed = false;
  let pending = null;
  return {
    async load({ number, headSha, generate = false }) {
      if (disposed || pending) return false;
      const controller = new AbortController();
      pending = controller;
      onStart(generate ? 'generate' : 'refresh');
      try {
        const result = await request(`/api/pulls/${number}/previews`, {
          method: generate ? 'POST' : 'GET',
          ...(generate ? { body: { headSha } } : {}),
          signal: controller.signal,
        });
        if (!disposed && !controller.signal.aborted) {
          if (typeof result?.configured !== 'boolean' || !Object.hasOwn(result, 'previews')) throw new Error('The preview service returned an unreadable status. Use Refresh status to try again.');
          onResult(result);
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted && error.name !== 'AbortError') onError(error);
      } finally {
        if (pending === controller) pending = null;
        if (!disposed && !controller.signal.aborted) onFinish();
      }
      return true;
    },
    dispose() {
      disposed = true;
      pending?.abort();
      pending = null;
    },
  };
}
