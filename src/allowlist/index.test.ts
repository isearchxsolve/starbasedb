import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('isQueryAllowed', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

        mockDataSource = {
            source: 'external',
            external: {
                dialect: 'sqlite',
            } as any,
            rpc: {
                executeQuery: vi.fn(),
            },
        } as any

        mockConfig = {
            role: 'user',
            outerbaseApiKey: 'mock-api-key',
        } as any
    })

    it('should return true immediately when isEnabled is false', async () => {
        const allowed = await isQueryAllowed({
            sql: 'DROP TABLE important_table',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(allowed).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return true immediately when config.role is admin', async () => {
        const allowed = await isQueryAllowed({
            sql: 'DELETE FROM accounts',
            isEnabled: true,
            dataSource: mockDataSource,
            config: { ...mockConfig, role: 'admin' },
        })
        expect(allowed).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should allow valid SQL matching the allowlist pattern', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            { source: 'external', sql_statement: 'SELECT id, name FROM users WHERE id = 1;' }
        ] as any)

        const allowed = await isQueryAllowed({
            sql: 'SELECT id, name FROM users WHERE id = 1',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(allowed).toBe(true)
    })

    it('should reject unapproved queries and record audit in tmp_allowlist_rejections', async () => {
        // Allowlist contains only SELECT
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                { source: 'external', sql_statement: 'SELECT id FROM users' }
            ] as any) // loadAllowlist
            .mockResolvedValueOnce([] as any) // addRejectedQuery

        await expect(isQueryAllowed({
            sql: 'DELETE FROM users WHERE id = 5',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })).rejects.toThrow('Query not allowed')

        // Verify rejected query was written to tmp_allowlist_rejections
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(expect.objectContaining({
            params: ['DELETE FROM users WHERE id = 5', 'external']
        }))
    })

    it('should throw an error if SQL string is empty or missing', async () => {
        await expect(isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })).rejects.toThrow()
    })
})
