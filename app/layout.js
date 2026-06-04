export const metadata = {
  title: "Hledač předmětů FF MUNI",
  description: "Zadej svůj vzdělávací cíl a najdi odpovídající předměty Filozofické fakulty MU.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}
