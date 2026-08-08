import { redirect } from 'next/navigation';

/** The product is the dashboard; a marketing page is not in scope. */
export default function Home() {
  redirect('/dashboard');
}
