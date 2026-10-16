// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { TaskHistoryPanel } from './TaskHistoryPanel';
import type { TaskRecord } from '../lib/task-history';

afterEach(cleanup);

describe('distribution history summary', () => {
  it.each([true, false])('includes an unresolved or failed approval in summary and review controls (uncertain=%s)', async (uncertain) => {
    const network = { kind: 'evm' as const, id: 'ethereum', label: 'Ethereum', chainId: 1 };
    const sender = `0x${'1'.repeat(40)}`;
    const record: TaskRecord = { id: 'round', toolId: 'evm-distribution', label: 'EVM 批量分发', network, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', results: [
      { address: sender, sourceAddress: sender, resultKind: 'approval', asset: 'TKN', label: 'Token 授权', hash: `0x${'a'.repeat(64)}`, status: 'error', uncertain, message: '授权结果' },
      { address: `0x${'2'.repeat(40)}`, resultKind: 'distribution', asset: 'TKN', status: 'skipped', uncertain: false, message: '分发未提交' }
    ] };
    render(<TaskHistoryPanel history={{ records: [record], updateRecord: vi.fn(), deleteRecord: vi.fn() }} network={network} rpcEndpoint="https://rpc.test" />);
    const expand = screen.queryByRole('button', { name: '展开可恢复任务记录' });
    if (expand) await userEvent.click(expand);
    expect(screen.getByText(new RegExp(`完成 0 · 失败 ${uncertain ? 0 : 1} · 待核对 ${uncertain ? 1 : 0} · 授权 1`))).toBeInTheDocument();
    if (uncertain) {
      expect(screen.getByRole('button', { name: '已人工核对链上结果' })).toBeVisible();
      expect(screen.getByRole('button', { name: '删除记录' })).toBeDisabled();
    }
  });
});
