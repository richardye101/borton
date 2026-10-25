export async function request(path, { csrf = '', method = 'GET', body, form } = {}) {
  const headers = {};
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : form });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Request failed.');
  return data;
}
