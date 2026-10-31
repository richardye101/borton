export async function request(path, { csrf = '', method = 'GET', body, form } = {}) {
  const headers = {};
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : form });
  const raw = await response.text();
  if (!raw.trim()) throw Error(`The server returned an empty response (${response.status || 'network error'}). Please try again.`);
  let data;
  try { data = JSON.parse(raw); }
  catch { throw Error('The server returned an invalid response. Please try again.'); }
  if (!response.ok) throw Error(data.error || 'Request failed.');
  return data;
}
