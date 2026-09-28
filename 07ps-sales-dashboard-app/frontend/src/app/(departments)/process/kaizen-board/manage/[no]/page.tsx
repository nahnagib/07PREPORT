'use client';
import { NoAccess } from '../../../../../../components/NoAccess';
import { KaizenCardForm } from '../../../../../../components/kaizen/KaizenCardForm';

/** Edit Kaizen card #no (Kaizen Cards: Edit). */
export default function EditKaizenCardPage({ params }: { params: { no: string } }) {
  const no = Number(params.no);
  if (!Number.isInteger(no) || no <= 0) return <NoAccess message="Card not found." />;
  return <KaizenCardForm cardNo={no} />;
}
