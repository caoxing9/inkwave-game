# Teable Integration Guide

## ⚠️ Critical Rules

1. **Server Actions Only**: Wrap all Teable calls in `"use server"` functions
2. **SQL for Queries**: Use `sqlQuery()` with `dbTableName` and `dbFieldName` from schema
3. **Field IDs for Writes**: Use `fldXXX` IDs when creating/updating records
4. **Double Quotes**: All SQL identifiers must use double quotes: `"schema"."table"`, `"field"`, aliases like `as "total"`
5. **No cross-table JOIN**: Each SQL query can only access ONE table. Query separately, join in JS
6. **Error resilience**: `sqlQuery()` throws on failure. Single-query pages let it throw (ErrorReporter catches it). Multi-query pages (dashboards) must use `Promise.allSettled` so one failed query doesn't crash the whole page — show error UI for failed sections, not silent empty data
7. **Rate limit (10 req/sec)**: For read-heavy / public pages, prefer Next.js ISR (see "ISR for read-heavy pages" below) to keep API calls flat under traffic spikes

## Quick Start

```typescript
// Server Action
"use server";
import { sqlQuery, createRecord, signAttachments, safeParseJson } from '@/lib/teable';

// Query (use dbTableName/dbFieldName from schema)
export async function getUsers() {
  const { rows } = await sqlQuery('bseXXX', 
    `SELECT "__id", "fld_name", "fld_status" FROM "bseXXX"."tbl_users" WHERE "fld_status" = 'Active' LIMIT 100`
  );
  return rows;
}

// Aggregation (no LIMIT needed; use COUNT("__id") not COUNT(*); always quote aliases)
export async function getStats() {
  const { rows } = await sqlQuery('bseXXX',
    `SELECT COUNT("__id") as "total", COALESCE(SUM(CAST("fld_amount" AS numeric)), 0) as "sum" FROM "bseXXX"."tbl_orders"`
  );
  return rows[0];
}

// Create (use field IDs)
export async function addUser(name: string) {
  return createRecord('tblXXX', { fldName: name, fldStatus: 'Active' });
}
```

## SQL Reference

| Rule | Example |
|------|---------|
| Table name | `"bseXXX"."tbl_users"` (from `dbTableName`) |
| Field name | `"fld_name"` (from `dbFieldName`) |
| Record ID | `"__id"` |
| String value | `'Active'` (single quotes) |
| Always add | `LIMIT 100` for non-aggregate queries |
| Aggregation | `COUNT("__id")` not `COUNT(*)`, always `COALESCE(SUM(...), 0)` |
| Aliases | Always double-quote: `as "total"`, `as "cnt"` |
| Number arithmetic | `CAST("fld" AS numeric)` for SUM/AVG |

### Field Type → SQL

| Type | SQL Usage |
|------|-----------|
| text | `"fld_name" = 'value'` |
| number | `CAST("fld_amount" AS numeric)` for SUM/AVG |
| checkbox | `"fld_done" = true` |
| singleSelect | `"fld_status" = 'Active'` |
| multipleSelect | `"fld_tags" @> '["tag1"]'` |
| date | `"fld_date" > '2024-01-01'` |
| attachment | Parse JSON, use `signAttachments()` |

### Link Field (Important!)

Single-value links have **two columns**: JSON (`dbFieldName`) and FK (`options.foreignKeyName`).

| Type | JSON Column | FK Column |
|------|-------------|-----------|
| Single (ManyOne/OneOne) | `{"id":"recXXX","title":"..."}` | `"__fk_fldXXX"` = `recXXX` |
| Multi (OneMany/ManyMany) | `[{"id":".."},{}]` | N/A (use JSON) |

**⚠️ Cross-table JOIN is NOT allowed — each SQL query can only access one table.** Use FK column to get the linked record ID, then query the other table separately and join in application code:

```typescript
// ✅ CORRECT: Separate queries + application-side join
const { rows: tasks } = await sqlQuery('bseXXX',
  `SELECT "__id", "fld_name", "__fk_fldProject" FROM "bseXXX"."tbl_tasks" LIMIT 100`
);
const { rows: projects } = await sqlQuery('bseXXX',
  `SELECT "__id", "fld_name" FROM "bseXXX"."tbl_projects" LIMIT 100`
);
const projMap = new Map(projects.map(p => [p.__id, p.fld_name]));
const result = tasks.map(t => ({
  ...t,
  project_name: projMap.get(t.__fk_fldProject) || null,
}));
```

```sql
-- ❌ WRONG: Cross-table JOIN causes "permission denied" error
SELECT t.*, p."fld_name" FROM "bseXXX"."tbl_tasks" t
LEFT JOIN "bseXXX"."tbl_projects" p ON p."__id" = t."__fk_fldProject";
```

**Multi-value links (use JSON within the same table):**
```sql
SELECT * FROM "bseXXX"."tbl_projects" WHERE "fld_tasks"::jsonb @> '[{"id":"recXXX"}]';
SELECT "fld_name", jsonb_array_length("fld_tasks"::jsonb) as "cnt" FROM "bseXXX"."tbl_projects";
```

### User Field

User fields: `{ id, title, email? }`. Check `isMultipleCellValue` for single vs multi.

```sql
-- Single user
SELECT "fld_assignee"::jsonb->>'id' as "user_id", "fld_assignee"::jsonb->>'title' as "user_name"
FROM "bseXXX"."tbl_tasks";

-- Multi user: check contains
SELECT * FROM "bseXXX"."tbl_tasks" WHERE "fld_members"::jsonb @> '[{"id":"usrXXX"}]';
```

## Attachments

Batch ALL attachments in ONE request:

```typescript
const { rows } = await sqlQuery(baseId, `SELECT "__id", "fld_files" FROM "bseXXX"."tbl_docs" LIMIT 50`);

// Collect all attachments (use safeParseJson from above)
const all = rows.flatMap(row => {
  const files = safeParseJson(row.fld_files) || [];
  return files.map((f: any) => ({ ...f, rowId: row.__id }));
});

// Sign once
const signed = await signAttachments(baseId, all);
```

## Write Operations

Use field IDs (`fldXXX`), not `dbFieldName`:

```typescript
await createRecord('tblXXX', { fldName: 'Task', fldStatus: 'Pending' });
await updateRecord('tblXXX', 'recXXX', { fldStatus: 'Done' });
await deleteRecord('tblXXX', 'recXXX');
```

| Type | Format |
|------|--------|
| Text | `"value"` |
| Number | `123.45` |
| Checkbox | `true` / `false` |
| Date | `"2024-01-15T00:00:00.000Z"` |
| Select | `"Option"` or `["A", "B"]` |
| User/Link | `["usrXXX"]` / `["recXXX"]` |

## ⚠️ Common Mistakes

### 1. Wrong field name
```sql
-- ❌ SELECT "Access Key" FROM ...     (uses 'name' with spaces)
-- ✅ SELECT "Access_Key" FROM ...     (uses 'dbFieldName')
```

### 2. Missing quotes
```sql
-- ❌ SELECT fld_name FROM bseXXX.users
-- ✅ SELECT "fld_name" FROM "bseXXX"."users"
```

### 3. Reserved words (must quote)
`"Group"`, `"Order"`, `"User"`, `"Date"`, `"Name"`, `"Status"`, `"Type"`, `"Key"`

### 4. Alias without quotes
```sql
-- ❌ SELECT "Group" as group FROM ...
-- ✅ SELECT "Group" as "group_name" FROM ...
```

### 5. Quote rule
- **Double quotes** `"..."` → identifiers (tables, fields, aliases)
- **Single quotes** `'...'` → string values

### 6. JSON field parsing
JSON fields (User, Link, Attachment) may be string OR already-parsed object. Always use safe parse:

```typescript
import { safeParseJson } from '@/lib/teable';

const user = safeParseJson(row.fld_assignee);
const attachments = safeParseJson(row.fld_files) || [];
```

### 7. COUNT(*) → use COUNT("__id")
```sql
-- ❌ COUNT(*)              (may cause permission issues)
-- ✅ COUNT("__id")         (explicit column reference)
```

### 8. Promise.all with raw sqlQuery
```typescript
// ❌ Promise.all + sqlQuery → one failure crashes all
await Promise.all([sqlQuery(...), sqlQuery(...), sqlQuery(...)]);

// ✅ Promise.allSettled → each query independent, check .status
const results = await Promise.allSettled([sqlQuery(...), sqlQuery(...), sqlQuery(...)]);
```

### 9. Silently swallowing errors
```typescript
// ❌ safeSqlQuery hides errors — user never knows something is broken
async function safeSqlQuery(sql: string) {
  try { return await sqlQuery(BASE_ID, sql); }
  catch { return { rows: [] }; }  // errors invisible!
}

// ✅ Promise.allSettled — errors are captured and shown in UI
const results = await Promise.allSettled([...]);
// results[i].status === "rejected" → show error message in that section
```

## Schema Files

`schema/table-{id}.json` contains:
- `dbTableName`: Use in SQL (e.g., `"bseXXX"."tbl_xxx"`)
- `fields[].dbFieldName`: Column name for SQL
- `fields[].id`: Field ID for write operations
- `fields[].isMultipleCellValue`: true = multi-value (link/user)
- `fields[].options.foreignKeyName`: FK column for single-value link (e.g., `"__fk_fldXXX"`)

## Runtime

Keep `<ErrorReporter />` in `app/layout.tsx`.

## Teable Resources Context

### Current Teable Project

- Project ID: `bse76v2JpRwtMeKsQbi`
- Use this `baseId` for any API that requires a project identifier

### Teable Resources Schema

All Teable table schemas are stored as JSON files under the `schema/` directory of this project.

Available tables (id → name → schema file):

- `tblylwFtd6BskMzv4RE` → 联机信令 → `schema/table-tblylwFtd6BskMzv4RE.json` (SQL: `"bse76v2JpRwtMeKsQbi"."tblylwFtd6BskMzv4RE"`)
- `tbl6fvBaDYLyW2lECRk` → 游戏玩家 → `schema/table-tbl6fvBaDYLyW2lECRk.json` (SQL: `"bse76v2JpRwtMeKsQbi"."tbl6fvBaDYLyW2lECRk"`)
- `tbllFvV6h7vYzKEYiSL` → 房间成员 → `schema/table-tbllFvV6h7vYzKEYiSL.json` (SQL: `"bse76v2JpRwtMeKsQbi"."tbllFvV6h7vYzKEYiSL"`)
- `tblztTPyuPXVV565blw` → 联机房间 → `schema/table-tblztTPyuPXVV565blw.json` (SQL: `"bse76v2JpRwtMeKsQbi"."tblztTPyuPXVV565blw"`)

