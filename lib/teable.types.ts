/**
 * Teable API Types
 * @description Type definitions for Teable API client
 */

// ============================================================================
// Field Types
// ============================================================================

export type FieldType =
  | 'singleLineText'
  | 'longText'
  | 'number'
  | 'checkbox'
  | 'singleSelect'
  | 'multipleSelect'
  | 'date'
  | 'user'
  | 'attachment'
  | 'rating'
  | 'link'
  | 'formula'
  | 'rollup'
  | 'conditionalRollup'
  | 'autoNumber'
  | 'createdTime'
  | 'lastModifiedTime'
  | 'createdBy'
  | 'lastModifiedBy'
  | 'button';

export type CellValueType = 'string' | 'number' | 'boolean' | 'dateTime';

// ============================================================================
// Record Types
// ============================================================================

export interface IUserCellValue {
  id: string;
  title: string;
  email?: string;
  avatar?: string;
}

export interface ILinkCellValue {
  id: string;
  title: string;
}

export interface IAttachmentCellValue {
  id: string;
  name: string;
  token: string;
  path: string;
  size: number;
  mimetype: string;
  presignedUrl?: string;
  width?: number;
  height?: number;
  smThumbnailUrl?: string;
  lgThumbnailUrl?: string;
}

export type CellValue =
  | string
  | number
  | boolean
  | string[]
  | IUserCellValue | IUserCellValue[]
  | ILinkCellValue | ILinkCellValue[]
  | IAttachmentCellValue[]
  | null;

export type RecordFields = Record<string, CellValue>;

export interface IRecord {
  id: string;
  fields: RecordFields;
  autoNumber?: number;
  createdTime?: string;
  lastModifiedTime?: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface ICreateRecordsInput {
  fields: RecordFields;
}

export interface ICreateRecordsResponse {
  records: IRecord[];
}

export interface IUpdateRecordsInput {
  id: string;
  fields: RecordFields;
}

// ============================================================================
// Attachment Types
// ============================================================================

export interface IAttachmentSignatureInput {
  contentType: string;
  contentLength: number;
  baseId?: string;
}

export interface IAttachmentSignatureResponse {
  url: string;
  uploadMethod: 'PUT' | 'POST';
  token: string;
  requestHeaders: Record<string, string>;
}

export interface IAttachmentNotifyResponse {
  token: string;
  size: number;
  url: string;
  mimetype: string;
  path: string;
  width?: number;
  height?: number;
  presignedUrl: string;
}
