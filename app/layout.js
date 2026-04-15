export const metadata = {
  title: 'whispr',
  description: 'temporary end-to-end encrypted chat',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#111111" />
      </head>
      <body style={{ margin: 0, padding: 0, background: '#111', WebkitTextSizeAdjust: '100%' }}>
        {children}
      </body>
    </html>
  )
}
