import { ToastContainer } from 'react-toastify';
import GodDashboard from './components/GodDashboard.tsx';

export default function Home() {
  return (
    <main className="min-h-screen font-body">
      <GodDashboard />
      <ToastContainer position="bottom-right" autoClose={2000} closeOnClick theme="dark" />
    </main>
  );
}
