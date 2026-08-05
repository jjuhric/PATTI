/**
 * Normalizes the local base URL to point to native /api/v1 or compat /v1
 */
function getNativeBaseUrl(localBaseUrl) {
  const clean = (localBaseUrl || 'http://localhost:1234/v1').trim().replace(/\/$/, '');
  if (clean.endsWith('/v1')) {
    return clean.replace(/\/v1$/, '/api/v1');
  }
  return clean + '/api/v1';
}

function getCompatBaseUrl(localBaseUrl) {
  const clean = (localBaseUrl || 'http://localhost:1234/v1').trim().replace(/\/$/, '');
  if (clean.endsWith('/v1')) {
    return clean;
  }
  return clean + '/v1';
}

/**
 * Fetches all available local models from LM Studio.
 * Detects loaded state using the native REST API response.
 */
async function listLocalModels(localBaseUrl, localApiKey) {
  const headers = {
    'Accept': 'application/json',
    ...(localApiKey ? { 'Authorization': `Bearer ${localApiKey}` } : {})
  };

  const nativeUrl = `${getNativeBaseUrl(localBaseUrl)}/models`;
  const compatUrl = `${getCompatBaseUrl(localBaseUrl)}/models`;

  try {
    const res = await fetch(nativeUrl, { headers });
    if (res.ok) {
      const data = await res.json();
      const modelsList = data.models || data.data || [];
      return modelsList.map(model => {
        const isLoaded = !!(model.loaded_instances && model.loaded_instances.length > 0);
        let instanceId = null;
        if (isLoaded) {
          const first = model.loaded_instances[0];
          if (first && typeof first === 'object') {
            instanceId = first.id || first.instance_id || first.instanceId || first.identifier || model.id;
          } else if (typeof first === 'string') {
            instanceId = first;
          } else {
            instanceId = model.id;
          }
        }
        return {
          id: model.id || model.key || '',
          name: model.name || model.id || '',
          isLoaded,
          instanceId
        };
      });
    }
  } catch (err) {
    console.warn(`[LM Studio] Native list models failed: ${err.message}. Retrying via compatibility endpoint.`);
  }

  // Fallback to OpenAI compatible list endpoint
  try {
    const resCompat = await fetch(compatUrl, { headers });
    if (resCompat.ok) {
      const data = await resCompat.json();
      const modelsList = data.data || [];
      return modelsList.map(model => ({
        id: model.id || '',
        name: model.id || '',
        isLoaded: false,
        instanceId: null
      }));
    }
  } catch (err) {
    console.error(`[LM Studio] Failed to list local models: ${err.message}`);
  }

  return [];
}

/**
 * Sends a POST request to load a model into LM Studio memory.
 */
async function loadLocalModel(localBaseUrl, localApiKey, modelId) {
  const url = `${getNativeBaseUrl(localBaseUrl)}/models/load`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(localApiKey ? { 'Authorization': `Bearer ${localApiKey}` } : {})
      },
      body: JSON.stringify({ model: modelId })
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`LM Studio HTTP ${res.status}: ${errorText}`);
    }
    return await res.json();
  } catch (err) {
    console.error(`[LM Studio] Failed to load model ${modelId}: ${err.message}`);
    throw err;
  }
}

/**
 * Sends a POST request to unload/eject a model instance from memory.
 */
async function unloadLocalModel(localBaseUrl, localApiKey, instanceId) {
  const url = `${getNativeBaseUrl(localBaseUrl)}/models/unload`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(localApiKey ? { 'Authorization': `Bearer ${localApiKey}` } : {})
      },
      body: JSON.stringify({ instance_id: instanceId })
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`LM Studio HTTP ${res.status}: ${errorText}`);
    }
    return await res.json();
  } catch (err) {
    console.error(`[LM Studio] Failed to unload model instance ${instanceId}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  listLocalModels,
  loadLocalModel,
  unloadLocalModel
};
