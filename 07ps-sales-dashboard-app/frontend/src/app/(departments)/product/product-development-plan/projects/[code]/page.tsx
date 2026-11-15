import PdpPage from '../../../../../../components/pdp/PdpPage';

/** Product Development Plan › project detail (components/pdp/PdpPage.tsx). */
export default function Page({ params }: { params: { code: string } }) {
  return <PdpPage section="project" code={decodeURIComponent(params.code)} />;
}
