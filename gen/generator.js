const path = require('path')
const fs = require('fs')
const {URL} = require('url')
const {promisify} = require('util')
const Sequelize = require('sequelize')
const cheerio = require('cheerio')
const fetch = require('node-fetch')

const writeFilePromise = promisify(fs.writeFile)

const root = path.resolve(__dirname, '..', 'amazon-web-services.docset')

const db = new Sequelize('database', 'username', 'password', {
        dialect: 'sqlite',
        storage: path.resolve(root, 'Contents/Resources/docSet.dsidx')
})
const SearchIndex = db.define('searchIndex', {
    id: { 
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: Sequelize.STRING
    },
    type: {
        type: Sequelize.STRING
    },
    path: {
        type: Sequelize.STRING
    },
    freezeTableName: true,
    timestmaps: false
})

const baseUrl = new URL('https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/')
const documentRoot = path.resolve(root, 'Contents/Resources/Documents')
const downloadedFiles = new Set()

const withImages = document => new Promise(resolve => {
    const resolver = resolve.bind({}, document)
    Promise.all(document('img').map((index, imgTag) => {
        const img = document(imgTag)
        if (!img.attr('src')) return

        const imageUrl = new URL(img.attr('src'), baseUrl.origin)
        const imageFilename = path.basename(imageUrl.pathname)
        const imagePath = path.resolve(documentRoot, 'img', imageFilename)

        img.attr('src', `./img/${imageFilename}`)
        if (downloadedFiles.has(imagePath)) return

        return fetch(imageUrl.toString())
            .then(res => res.arrayBuffer())
            .then(res => writeFilePromise(imagePath, new Buffer(res)))
            .then(_ => downloadedFiles.add(imagePath))
            .catch(console.error)
    }).get()).then(resolver).catch(console.error)
})

const withStylesheets = document => new Promise(resolve => {
    const resolver = resolve.bind({}, document)
    Promise.all(document('link[rel="stylesheet"]').map((index, linkTag) => {
        const link = document(linkTag)
        if (!link.attr('href')) return

        const linkUrl = new URL(link.attr('href'), baseUrl.origin)
        const linkFilename = path.basename(linkUrl.pathname)
        const linkPath = path.resolve(documentRoot, 'css', linkFilename)

        link.attr('href', `./css/${linkFilename}`)
        if (downloadedFiles.has(linkPath)) return

        return fetch(linkUrl.toString())
            .then(res => res.arrayBuffer())
            .then(res => writeFilePromise(linkPath, new Buffer(res)))
            .then(_ => downloadedFiles.add(linkPath))
            .catch(console.error)
    }).get()).then(resolver).catch(console.error)
})

const withRelativeLinks = document => new Promise(resolve => {
    document('a').each((index, aTag) => {
        const a = document(aTag)
        if (a.attr('href')) a.attr('href', a.attr('href').replace(baseUrl.href, './'))
        if (a.attr('href')) a.attr('href', a.attr('href').replace(baseUrl.href.replace('https', 'http'), './'))
    })
    resolve(document)
})

const withoutNavigation = document => new Promise(resolve => {
    document('#left-column').remove()
    document('#aws-nav').remove()
    document('#footer').remove()
    resolve(document)
})

const docSet = new Array()
const downloadDocPage = url =>
    fetch(`${baseUrl.href}${url}`)
        .then(res => res.text())
        .then(cheerio.load)
        .then(withoutNavigation)
        .then(withRelativeLinks)
        .then(withImages)
        .then(withStylesheets)
        .then(document => {
            const title = document('title').text()
            console.log(` - Saving "${title}" (${url})`)

            const documentPath = path.resolve(documentRoot, url)
            return writeFilePromise(documentPath, document.root().html())
                .then(_ => {
                    docSet.push({ 
                        name: title,
                        type: 'Guide',
                        path: url
                    })
                })
                .then(url => {
                    const nextPage = document('link[rel="next"]').attr('href')
                    return (nextPage) ? downloadDocPage(nextPage) : url
                })
        })

downloadDocPage('Welcome.html')
        .then(_ => SearchIndex.sync({ force: true }))
        .then(_ => SearchIndex.bulkCreate(docSet))
        .catch(console.error)