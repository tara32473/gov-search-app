# API Docs

## `POST /api/register`
Creates a user (body: `{ username, password }`). Returns JWT token.

## `POST /api/login`
Logs in a user (body: `{ username, password }`). Returns JWT token.

## `GET /api/search`
Search Congress members (must send `Authorization: Bearer <token>`).
- Query: `name`, `state`, `party`
- Returns array of matching members

## `POST /api/admin/addcongress`
Add test congress members (body: `{ id, name, party, state, data }`)

---