import { describe, expect, it, vi } from 'vitest'

const executeOperation = vi.fn()

vi.mock('.', () => ({
    executeOperation,
}))

vi.mock('../utils', () => ({
    createResponse: (_data: unknown, message: string, status: number) =>
        new Response(message, { status }),
}))

import { dumpDatabaseRoute } from './dump'

async function responseText(response: Response): Promise<string> {
    return await response.text()
}

describe('dumpDatabaseRoute', () => {
    it('streams a valid SQL dump without constructing a Blob', async () => {
        executeOperation.mockImplementation(async (queries: any[]) => {
            const { sql, params } = queries[0]

            if (sql.includes("FROM sqlite_master") && sql.includes("type = 'table'")) {
                return [{ name: 'users' }]
            }

            if (sql.includes('WHERE type = \'table\' AND name = ?')) {
                expect(params).toEqual(['users'])
                return [{ sql: 'CREATE TABLE users (id INTEGER, name TEXT)' }]
            }

            if (sql.includes('SELECT _rowid_')) {
                const after = params[0]

                if (after === 0) {
                    return [
                        {
                            __starbase_rowid__: 1,
                            id: 1,
                            name: "O'Reilly",
                        },
                    ]
                }

                return []
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        const response = await dumpDatabaseRoute(
            {} as any,
            { role: 'admin' },
            1
        )

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toContain('application/sql')
        expect(response.headers.get('Content-Disposition')).toContain(
            'database_dump.sql'
        )

        expect(await responseText(response)).toBe(
            [
                'BEGIN TRANSACTION;',
                '',
                '-- Table: "users"',
                'CREATE TABLE users (id INTEGER, name TEXT);',
                `INSERT INTO "users" ("id", "name") VALUES (1, 'O''Reilly');`,
                'COMMIT;',
                '',
            ].join('\n')
        )
    })

    it('uses keyset pagination and never emits OFFSET for rowid tables', async () => {
        const observedSql: string[] = []

        executeOperation.mockImplementation(async (queries: any[]) => {
            const { sql, params } = queries[0]
            observedSql.push(sql)

            if (sql.includes("FROM sqlite_master") && sql.includes("type = 'table'")) {
                return [{ name: 'events' }]
            }

            if (sql.includes('WHERE type = \'table\' AND name = ?')) {
                return [{ sql: 'CREATE TABLE events (id INTEGER)' }]
            }

            if (sql.includes('SELECT _rowid_')) {
                const after = params[0]

                if (after === 0) {
                    return [
                        { __starbase_rowid__: 10, id: 10 },
                        { __starbase_rowid__: 20, id: 20 },
                    ]
                }

                if (after === 20) {
                    return [{ __starbase_rowid__: 30, id: 30 }]
                }

                return []
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        const response = await dumpDatabaseRoute(
            {} as any,
            { role: 'admin' },
            2
        )

        const output = await responseText(response)

        expect(output.match(/INSERT INTO "events"/g)).toHaveLength(3)
        expect(observedSql.some((sql) => sql.includes('_rowid_ > ?'))).toBe(true)
        expect(observedSql.some((sql) => sql.includes('OFFSET'))).toBe(false)
    })

    it('falls back to bounded OFFSET pagination for WITHOUT ROWID tables', async () => {
        executeOperation.mockImplementation(async (queries: any[]) => {
            const { sql, params } = queries[0]

            if (sql.includes("FROM sqlite_master") && sql.includes("type = 'table'")) {
                return [{ name: 'lookup' }]
            }

            if (sql.includes('WHERE type = \'table\' AND name = ?')) {
                return [
                    {
                        sql: 'CREATE TABLE lookup (key TEXT PRIMARY KEY) WITHOUT ROWID',
                    },
                ]
            }

            if (sql.includes('SELECT _rowid_')) {
                throw new Error('no such column: _rowid_')
            }

            if (sql.includes('LIMIT ? OFFSET ?')) {
                return params[1] === 0 ? [{ key: 'first' }] : []
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        const response = await dumpDatabaseRoute(
            {} as any,
            { role: 'admin' },
            1
        )

        const output = await responseText(response)

        expect(output).toContain(
            `INSERT INTO "lookup" ("key") VALUES ('first');`
        )
    })

    it('serializes nulls, booleans, blobs, numbers, and quoted strings correctly', async () => {
        executeOperation.mockImplementation(async (queries: any[]) => {
            const { sql, params } = queries[0]

            if (sql.includes("FROM sqlite_master") && sql.includes("type = 'table'")) {
                return [{ name: 'values' }]
            }

            if (sql.includes('WHERE type = \'table\' AND name = ?')) {
                return [{ sql: 'CREATE TABLE values (a, b, c, d, e)' }]
            }

            if (sql.includes('SELECT _rowid_')) {
                return params[0] === 0
                    ? [
                          {
                              __starbase_rowid__: 1,
                              a: null,
                              b: true,
                              c: 42.5,
                              d: new Uint8Array([0, 15, 255]),
                              e: "it's safe",
                          },
                      ]
                    : []
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        const response = await dumpDatabaseRoute(
            {} as any,
            { role: 'admin' },
            10
        )

        expect(await responseText(response)).toContain(
            `VALUES (NULL, 1, 42.5, X'000fff', 'it''s safe');`
        )
    })

    it('returns a normal 500 response when metadata resolution fails', async () => {
        executeOperation.mockRejectedValueOnce(new Error('storage unavailable'))

        const response = await dumpDatabaseRoute(
            {} as any,
            { role: 'admin' }
        )

        expect(response.status).toBe(500)
        expect(await response.text()).toBe('Failed to create database dump')
    })

    it('rejects invalid page sizes before querying the Durable Object', async () => {
        const response = await dumpDatabaseRoute(
            {} as any,
            { role: 'admin' },
            0
        )

        expect(response.status).toBe(400)
        expect(executeOperation).not.toHaveBeenCalled()
    })
})
