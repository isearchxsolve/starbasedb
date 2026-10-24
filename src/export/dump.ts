import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const encoder = new TextEncoder()
const DEFAULT_PAGE_SIZE = 500

type Row = Record<string, unknown>

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('Cannot export non-finite numeric SQLite values')
        }
        return String(value)
    }

    if (typeof value === 'bigint') return value.toString()

    if (typeof value === 'boolean') return value ? '1' : '0'

    if (value instanceof Uint8Array) {
        let hex = ''
        for (const byte of value) hex += byte.toString(16).padStart(2, '0')
        return `X'${hex}'`
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

async function breathe(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function getTables(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const result = await executeOperation(
        [
            {
                sql: `
                    SELECT name
                    FROM sqlite_master
                    WHERE type = 'table'
                      AND name NOT LIKE 'sqlite_%'
                    ORDER BY name
                `,
            },
        ],
        dataSource,
        config
    )

    return result.map((row: Row) => String(row.name))
}

async function getSchema(
    table: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string | null> {
    const result = await executeOperation(
        [
            {
                sql: `
                    SELECT sql
                    FROM sqlite_master
                    WHERE type = 'table' AND name = ?
                `,
                params: [table],
            },
        ],
        dataSource,
        config
    )

    return result.length > 0 && typeof result[0].sql === 'string'
        ? result[0].sql
        : null
}

async function fetchRowIdPage(
    table: string,
    afterRowId: number,
    pageSize: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Array<Row & { __starbase_rowid__: number }>> {
    return executeOperation(
        [
            {
                sql: `
                    SELECT _rowid_ AS __starbase_rowid__, *
                    FROM ${quoteIdentifier(table)}
                    WHERE _rowid_ > ?
                    ORDER BY _rowid_
                    LIMIT ?
                `,
                params: [afterRowId, pageSize],
            },
        ],
        dataSource,
        config
    ) as Promise<Array<Row & { __starbase_rowid__: number }>>
}

async function fetchOffsetPage(
    table: string,
    offset: number,
    pageSize: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Row[]> {
    return executeOperation(
        [
            {
                sql: `
                    SELECT *
                    FROM ${quoteIdentifier(table)}
                    LIMIT ? OFFSET ?
                `,
                params: [pageSize, offset],
            },
        ],
        dataSource,
        config
    ) as Promise<Row[]>
}

async function* dumpChunks(
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize: number
): AsyncGenerator<string> {
    yield 'BEGIN TRANSACTION;\n'

    for (const table of tables) {
        const schema = await getSchema(table, dataSource, config)
        if (!schema) continue

        yield `\n-- Table: ${quoteIdentifier(table)}\n${schema};\n`

        let rowId = 0
        let offset = 0
        let usesRowId = true

        while (true) {
            let page: Row[]

            if (usesRowId) {
                try {
                    page = await fetchRowIdPage(
                        table,
                        rowId,
                        pageSize,
                        dataSource,
                        config
                    )
                } catch {
                    usesRowId = false
                    offset = 0
                    continue
                }
            } else {
                page = await fetchOffsetPage(
                    table,
                    offset,
                    pageSize,
                    dataSource,
                    config
                )
            }

            if (page.length === 0) break

            let output = ''

            for (const sourceRow of page) {
                const row = { ...sourceRow }
                const currentRowId = row.__starbase_rowid__
                delete row.__starbase_rowid__

                const columns = Object.keys(row).map(quoteIdentifier).join(', ')
                const values = Object.values(row).map(sqlLiteral).join(', ')

                output += `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${values});\n`

                if (usesRowId) rowId = Number(currentRowId)
            }

            yield output

            if (usesRowId) {
                if (page.length < pageSize) break
            } else {
                offset += page.length
                if (page.length < pageSize) break
            }

            await breathe()
        }
    }

    yield 'COMMIT;\n'
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize = DEFAULT_PAGE_SIZE
): Promise<Response> {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) {
        return createResponse(undefined, 'Invalid export page size', 400)
    }

    try {
        // Resolve table metadata before committing an HTTP 200 stream.
        const tables = await getTables(dataSource, config)
        const iterator = dumpChunks(tables, dataSource, config, pageSize)

        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const next = await iterator.next()

                    if (next.done) {
                        controller.close()
                        return
                    }

                    controller.enqueue(encoder.encode(next.value))
                } catch (error) {
                    controller.error(error)
                }
            },
            async cancel() {
                await iterator.return?.()
            },
        })

        return new Response(body, {
            headers: {
                'Content-Type': 'application/sql; charset=utf-8',
                'Content-Disposition':
                    'attachment; filename="database_dump.sql"',
                'Cache-Control': 'no-store',
            },
        })
    } catch (error) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
