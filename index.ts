import express, { Express, Request, Response } from 'express'
import { monitor } from './src/monitor'

const app: Express = express()

app.get('/', (req: Request, res: Response) => {
    res.send('ospex api service')
})

const PORT = process.env.PORT || 8001

app.listen(PORT, () => { 
    monitor()
    console.log(`App listening on port ${PORT}!`)
})
