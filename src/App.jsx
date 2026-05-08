import { Card, Button, Separator } from '@heroui/react'

function App() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 gap-8">
      <Card.Root className="max-w-md w-full">
        <Card.Header className="flex justify-center">
          <Card.Title className="text-3xl font-bold">sfmmm</Card.Title>
        </Card.Header>
        <Separator />
        <Card.Content className="flex flex-col items-center gap-4 py-8">
          <p className="text-default-500 text-center">
            Tauri + Vite + React + HeroUI
          </p>
          <div className="flex gap-4">
            <Button color="primary" variant="solid">
              Get Started
            </Button>
            <Button color="secondary" variant="flat">
              Learn More
            </Button>
          </div>
        </Card.Content>
      </Card.Root>
    </div>
  )
}

export default App