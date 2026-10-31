import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VisualInfoIcons } from '@07ps/ui';
import { vh, vhById, type VisualHelpId } from '../visualHelp';
afterEach(cleanup);
describe('minimal visual hint policy', () => {
  it.each([
    'promotion.tachometer.ytdValue','promotion.tachometer.ytdVolume','promotion.tachometer.mtdValue','promotion.tachometer.mtdVolume',
    'promotion.criticalNumber.dailyCounter','promotion.criticalNumber.monthlyCounter','promotion.criticalNumber.yearlyCounter',
    'promotion.revenueTrend.momValue','promotion.revenueTrend.momVolume','promotion.revenueTrend.momAsp',
    'promotion.invoicesEngine.linesPerInvoice','promotion.invoicesEngine.salesPerInvoice','promotion.invoicesEngine.volumePerInvoice',
    'promotion.customerGrowth.newCustomers','promotion.customerGrowth.categoryShare','promotion.customerGrowth.contribution',
    'promotion.pipelineTrend.opportunities','promotion.pipelineTrend.quotations','promotion.pipelineTrend.salesOrders',
    'price.receivables.trend','price.receivables.collections',
    'process.kaizen.byStatus','process.kaizen.byType','process.kaizen.byDepartment','process.kaizen.responsible',
    'process.npsScore.satisfactionTrend','process.npsScore.respondersTrend','process.npsScore.reach','process.npsScore.errors',
  ] satisfies VisualHelpId[])('does not add ? to %s', id => {
    render(<VisualInfoIcons title={id} {...vh(id)} />);
    expect(screen.queryByRole('button', {name:'About this visual'})).toBeNull();
  });
  it.each(['workingDays','holidays','closures','restDays'])('shows neither icon for %s', suffix => {
    const hints = vh(`promotion.criticalNumber.${suffix}` as VisualHelpId);
    render(<VisualInfoIcons title={suffix} {...hints} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it.each(['missingValue','missingDays'])('shows an actionable i for %s', suffix => {
    render(<VisualInfoIcons title={suffix} {...vh(`promotion.criticalNumber.${suffix}` as VisualHelpId)} />);
    expect(screen.queryByRole('button', {name:'About this visual'})).toBeNull();
    fireEvent.focus(screen.getByRole('button', {name:'How to interact'}));
    expect(screen.getByRole('tooltip').textContent).toContain('full chart and breakdown table');
  });
  it.each(['process.npsScore.nps','process.npsScore.csat','process.npsScore.responseRate','promotion.customerGrowth.retention','promotion.pipelineTrend.quotationRates'] satisfies VisualHelpId[])('retains the rate/score equation for %s', id => {
    render(<VisualInfoIcons title={id} {...vh(id)} />);
    fireEvent.focus(screen.getByRole('button', {name:'About this visual'}));
    expect(screen.getByTestId('visual-help-formula')).toBeTruthy();
  });
  it('uses the same policy for dynamic ids', () => {
    expect(vhById('process.kaizen.byStatus')?.help).toBeUndefined();
    expect(vhById('unregistered')).toBeUndefined();
  });
});
