/**
 * Teable API Client - Server-side only
 * @description Streamlined API client with SQL query as the primary data access method
 * 
 * ⚠️ IMPORTANT: This module must only be used in server-side code (API routes, server actions).
 * Never import this in client-side components.
 */

import { getConfig, request } from './request';
import type {
  RecordFields,
  IRecord,
  ICreateRecordsInput,
  ICreateRecordsResponse,
  IUpdateRecordsInput,
  IAttachmentSignatureInput,
  IAttachmentSignatureResponse,
  IAttachmentNotifyResponse,
} from './teable.types';

export type * from './teable.types';

// ── SQL Query ───────────────────────────────────────────────────

interface ISqlQueryResponse {
  rows: Record<string, unknown>[];
}

/**
 * Execute SQL query on the database (READ-ONLY)
 * 
 * This is the primary method for querying data. Use this for:
 * - Fetching records with complex filters
 * - Aggregations (COUNT, SUM, AVG, MIN, MAX, etc.)
 * - Any SELECT query
 * 
 * @param baseId - Base ID from schema file
 * @param sql - PostgreSQL SELECT query using dbTableName and dbFieldName from schema
 * 
 * @example
 * // Simple query - use dbTableName from schema (e.g., "bseXXX"."users")
 * const { rows } = await sqlQuery('bseXXX', 
 *   `SELECT "__id", "fld_name", "fld_email" 
 *    FROM "bseXXX"."users" 
 *    WHERE "fld_status" = 'Active' 
 *    LIMIT 100`
 * );
 * 
 * @example
 * // Aggregation query
 * const { rows } = await sqlQuery('bseXXX',
 *   `SELECT COUNT(*) as total, SUM(CAST("fld_amount" AS numeric)) as sum 
 *    FROM "bseXXX"."orders"`
 * );
 */
export async function sqlQuery(baseId: string, sql: string): Promise<ISqlQueryResponse> {
  return request<ISqlQueryResponse>(`/base/${baseId}/sql-query`, {
    method: 'POST',
    body: { sql },
  });
}

// ── JSON Parsing ────────────────────────────────────────────────

/**
 * Safely parse JSON fields from SQL results.
 * JSON fields (User, Link, Attachment) may be string OR already-parsed object.
 *
 * @example
 * const user = safeParseJson(row.fld_assignee);
 * const attachments = safeParseJson(row.fld_files) || [];
 */
export function safeParseJson(value: unknown): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

// ── Attachment URL Signing ──────────────────────────────────────

/**
 * Sign attachment URLs to get presigned URLs for browser display.
 *
 * PERFORMANCE TIP: Collect ALL attachments from ALL rows first, then call this once.
 *
 * @param baseId - Base ID
 * @param attachments - Array of attachment objects (use safeParseJson to parse from SQL)
 * @returns Same attachments array with presignedUrl added to each (matched by token)
 *
 * @example
 * const { rows } = await sqlQuery(baseId, 'SELECT "__id", "fld_files" FROM "bseXXX"."docs" LIMIT 50');
 * const allAttachments = rows.flatMap(row => safeParseJson(row.fld_files) || []);
 * const signed = await signAttachments(baseId, allAttachments);
 */
export async function signAttachments<T extends { path: string; token: string; mimetype?: string }>(
  baseId: string,
  attachments: T[]
): Promise<Array<{ path: string; token: string; presignedUrl: string }>> {
  if (!attachments || attachments.length === 0) return [];

  const response = await request<{ attachments: { token: string; url: string }[] }>(
    `/base/${baseId}/sign-attachment-urls`,
    {
      method: 'POST',
      body: { attachments: attachments.map(att => ({ path: att.path, token: att.token, mimetype: att.mimetype })) },
    }
  );

  const urlMap = new Map(response.attachments.map(s => [s.token, s.url]));
  return attachments.map(att => ({
    ...att,
    presignedUrl: urlMap.get(att.token) || '',
  }));
}

// ── Records CRUD ────────────────────────────────────────────────

/**
 * Create one or more records
 * @example
 * const { records } = await createRecords('tblXXX', [
 *   { fields: { fldName: 'John', fldAge: 25 } },
 *   { fields: { fldName: 'Jane', fldAge: 30 } },
 * ]);
 */
export async function createRecords(
  tableId: string,
  records: ICreateRecordsInput[]
): Promise<ICreateRecordsResponse> {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Records must be a non-empty array');
  }
  return request<ICreateRecordsResponse>(`/table/${tableId}/record`, {
    method: 'POST',
    body: { fieldKeyType: 'id', typecast: true, records },
  });
}

/** Create a single record (convenience method) */
export async function createRecord(tableId: string, fields: RecordFields): Promise<IRecord> {
  const { records } = await createRecords(tableId, [{ fields }]);
  return records[0];
}

/**
 * Update a single record
 * @example
 * await updateRecord('tblXXX', 'recXXX', { fldName: 'New Name' });
 */
export async function updateRecord(
  tableId: string,
  recordId: string,
  fields: RecordFields
): Promise<IRecord> {
  return request<IRecord>(`/table/${tableId}/record/${recordId}`, {
    method: 'PATCH',
    body: { fieldKeyType: 'id', typecast: true, record: { fields } },
  });
}

/**
 * Update multiple records at once
 * @example
 * await updateRecords('tblXXX', [
 *   { id: 'recXXX', fields: { fldName: 'Name 1' } },
 *   { id: 'recYYY', fields: { fldName: 'Name 2' } },
 * ]);
 */
export async function updateRecords(
  tableId: string,
  records: IUpdateRecordsInput[]
): Promise<IRecord[]> {
  const response = await request<{ records: IRecord[] }>(`/table/${tableId}/record`, {
    method: 'PATCH',
    body: { fieldKeyType: 'id', typecast: true, records },
  });
  return response.records;
}

export async function deleteRecord(tableId: string, recordId: string): Promise<void> {
  await request(`/table/${tableId}/record/${recordId}`, { method: 'DELETE' });
}

export async function deleteRecords(tableId: string, recordIds: string[]): Promise<void> {
  await request(`/table/${tableId}/record`, {
    method: 'DELETE',
    params: { recordIds: recordIds.join(',') },
  });
}

// ── Attachments ─────────────────────────────────────────────────

export async function getAttachmentSignature(
  input: IAttachmentSignatureInput
): Promise<IAttachmentSignatureResponse> {
  return request<IAttachmentSignatureResponse>('/attachments/signature', {
    method: 'POST',
    body: { ...input, type: 1 },
  });
}

export async function notifyAttachmentUpload(
  token: string,
  filename: string
): Promise<IAttachmentNotifyResponse> {
  return request<IAttachmentNotifyResponse>(`/attachments/notify/${token}`, {
    method: 'POST',
    params: { filename },
  });
}

export async function uploadAttachmentToRecord(
  tableId: string,
  recordId: string,
  fieldId: string,
  file: Blob | { url: string }
): Promise<void> {
  const { baseUrl, token } = getConfig();
  const url = `${baseUrl}/api/table/${tableId}/record/${recordId}/${fieldId}/uploadAttachment`;

  const formData = new FormData();
  if ('url' in file) {
    formData.append('fileUrl', file.url);
  } else {
    formData.append('file', file);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(`Teable API Error [${response.status}]: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Full attachment upload flow for new records
 * @returns Attachment object ready to use in record creation
 */
export async function uploadNewAttachment(
  file: Blob,
  filename: string,
  baseId?: string
): Promise<{ name: string; token: string }> {
  const signature = await getAttachmentSignature({
    contentType: file.type || 'application/octet-stream',
    contentLength: file.size,
    baseId,
  });

  const uploadHeaders: Record<string, string> = { ...signature.requestHeaders };
  delete uploadHeaders['Content-Length'];

  const uploadResponse = await fetch(signature.url, {
    method: signature.uploadMethod,
    headers: uploadHeaders,
    body: file,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload file to storage: ${uploadResponse.statusText}`);
  }

  const notifyResult = await notifyAttachmentUpload(signature.token, filename);
  return { name: filename, token: notifyResult.token };
}

// ── Convenience Export ──────────────────────────────────────────

export const teable = {
  sqlQuery,
  safeParseJson,
  signAttachments,
  createRecord,
  createRecords,
  updateRecord,
  updateRecords,
  deleteRecord,
  deleteRecords,
  getAttachmentSignature,
  notifyAttachmentUpload,
  uploadAttachmentToRecord,
  uploadNewAttachment,
};

export default teable;
