import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { add, mul, sub } from './calc.js'

test('add', () => assert.equal(add(2, 3), 5))
test('sub', () => assert.equal(sub(5, 3), 2))
test('mul', () => assert.equal(mul(4, 3), 12))
