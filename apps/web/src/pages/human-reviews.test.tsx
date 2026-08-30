// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HumanReviewsPage } from './HumanReviewsPage';
const api = vi.hoisted(() => ({ listReviews: vi.fn(), getReview: vi.fn(), approveReview: vi.fn(), rejectReview: vi.fn(), takeOverReview: vi.fn(), closeReview: vi.fn() }));
vi.mock('../api/reviews', () => api);
const review = { id:'review-1',caseId:'case-1',status:'PENDING',reviewKey:'key',reasonForReview:'Amount requires review',createdAt:'2025-01-01T00:00:00Z',case:{id:'case-1',status:'NEEDS_REVIEW',riskType:'PAYMENT_FAILURE',amountAtRisk:'99.00',currency:'INR',customer:{id:'c',name:'Ada'}},planVersion:{version:1,diagnosisSummary:'Declined',confidence:.9,proposedActionType:'SEND_PAYMENT_LINK',proposedActionParams:{message:'safe'}} };
const view=(node:React.ReactNode)=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>{node}</QueryClientProvider>);
describe('human review operations',()=>{
 it('renders pending inbox and navigation',async()=>{api.listReviews.mockResolvedValue({reviews:[review]});const nav=vi.fn();view(<HumanReviewsPage navigate={nav}/>);expect(await screen.findByText('Amount requires review')).toBeTruthy();fireEvent.click(screen.getByText('case-1'));expect(nav).toHaveBeenCalledWith('/reviews/review-1');});
 it('renders empty inbox',async()=>{api.listReviews.mockResolvedValue({reviews:[]});view(<HumanReviewsPage navigate={vi.fn()}/>);expect(await screen.findByText('No pending human reviews')).toBeTruthy();});
 it('uses exact mutation endpoints and requires reasons',async()=>{api.getReview.mockResolvedValue({review});api.approveReview.mockResolvedValue({approved:true});api.rejectReview.mockResolvedValue({rejected:true});api.closeReview.mockResolvedValue({closed:true});view(<HumanReviewsPage reviewId="review-1" navigate={vi.fn()}/>);await screen.findByText('Amount requires review');expect((screen.getByText('Reject') as HTMLButtonElement).disabled).toBe(true);fireEvent.change(screen.getByLabelText('Notes'),{target:{value:'review note'}});fireEvent.click(screen.getByText('Approve exact proposal'));await waitFor(()=>expect(api.approveReview).toHaveBeenCalledWith('review-1','review note'));fireEvent.change(screen.getByLabelText('Reason'),{target:{value:'not suitable'}});fireEvent.click(screen.getByText('Reject'));await waitFor(()=>expect(api.rejectReview).toHaveBeenCalledWith('review-1','not suitable','review note'));});
});
