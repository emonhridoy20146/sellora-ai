'use client';

/** When even the store could not be loaded (the API is down). */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100dvh',
          margin: 0,
          textAlign: 'center',
          padding: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 20 }}>The shop is not available right now.</h1>
          <p style={{ color: '#555' }}>দোকানটি এখন খোলা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।</p>
          <button type="button" onClick={reset} style={{ marginTop: 16, padding: '10px 18px' }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
