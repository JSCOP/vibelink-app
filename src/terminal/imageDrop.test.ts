import { describe, expect, it } from 'vitest'
import { terminalImageDropText } from './imageDrop'

describe('terminal image drop', () => {
  it('quotes image paths for terminal paste and rejects non-images', () => {
    expect(terminalImageDropText(['C:\\Shots\\one image.png', 'D:\\two.JPG']))
      .toBe('"C:\\Shots\\one image.png" "D:\\two.JPG"')
    expect(terminalImageDropText(['C:\\notes.txt'])).toBeNull()
  })
})
